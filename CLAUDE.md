# NFT Mint Underwriter — build context

Drop this at the repo root as `CLAUDE.md` so it loads automatically, or keep
it as `HANDOFF.md` and reference it in your first message.

---

## What we're building and why

An **NFT mint underwriter with an execution arm**, built on top of this
repo (Degen Assistant Bot). Not a faster sniper.

The strategic premise, which every technical decision follows from: we
cannot win latency races. Operating from Lagos on public RPC means 150–250ms
RTT against competitors colocated near the sequencer. That gap is physics,
not code. So we don't compete on speed — we compete on **selection** (not
minting rugs), **exits** (most bots have none), and **chain timing** (young
chains where bot infrastructure hasn't arrived).

Two open-source mint bots were studied as references:

- `zunmax/osnm-z` — Rust, OpenSea SeaDrop, EIP-7702 sponsored batching,
  staged T-10/T-2 capture, replacement bumping at 112.5%, `doctor`
  preflight. Weakness: OpenSea's private API sits on the critical path and
  it signs opaque calldata it can't verify.
- `morsyxbt/nft-public-mint` — TypeScript, builds calldata from on-chain
  state so nothing external is in the critical path, pre-signs and
  pre-serialises, warms sockets, blasts to all endpoints, distinguishes
  dispatched/accepted/mined. Weakness: static gas, no replacement bump, no
  simulation, public stages only.

**Neither has discovery, risk filtering, simulation, or exits.** Those are
four of our six planned services. Take morsy's execution spine, take
zunmax's coverage, drop the external dependency from the critical path.

Target architecture: Ingest → Graph → Underwriter → Executor → Exit engine →
Telegram. Underwriter runs four stages, cheapest first: (A) bytecode gate,
(B) exit simulation, (C) deployer reputation, (D) demand score.

---

## What's already landed

**`src/risk/nftDangerousFunctions.js`** — Stage A, the deterministic hard
gate. Complete and tested.

- 82 selectors across six tables, each computed as `keccak256(sig)[0:4]` and
  verified against published values. Tiered: fatal (seizure, transfer lock),
  deduction (metadata, supply, economics, upgrade), positive (freeze).
- Resolves EIP-1167, EIP-1967, EIP-1822, and beacon proxies. The token-side
  `dangerousFunctions.js` only handles 1167, which reads every proxied drop
  as falsely clean.
- Assesses metadata rather than pattern-matching: a `setBaseURI` setter alone
  is normal for delayed reveal. **Mutable setter AND non-content-addressed
  host** is the rug.
- Returns `checked` explicitly. Unknown costs points instead of passing as
  clean.
- Exports: `detectNftDangerousFunctions(chain, addr, { budgetMs })`,
  `assessNftContractRisk(scan)`, `prewarmNftScans(chain, addrs)`.
- One round trip for a plain contract, two for a proxy, three for a beacon.
  Compute is sub-millisecond; latency is entirely network.

**`src/telegram/formatNftScan.js`** — renders a scan for Telegram.

**`scripts/nftScan.js`** — CLI. `node scripts/nftScan.js <chain> <addr...>`.
Read-only, no wallet.

**`src/wallet.js`** — patched with `staticNetwork`. Not optional: without it
an unreachable endpoint enters an indefinite "failed to detect network" retry
loop and every call behind it blocks forever, which no timeout or budget can
rescue because a budget can only race a promise that eventually settles.

**Tests** — 19 across two suites, all green.

```bash
node --experimental-test-module-mocks tests/nftDangerousFunctions.test.mjs
TELEGRAM_BOT_TOKEN=x TELEGRAM_CHAT_ID=1 node tests/formatNftScan.test.mjs
```

---

## Outstanding

**Immediate:**

1. **Apply the `bot.js` edits** in `TELEGRAM_WIRING.md` — three additive
   changes adding `/nftcheck`. Deliberately separate from `/nftscore`,
   which routes through `detectNftChain` and throws when OpenSea hasn't
   indexed the collection. `/nftcheck` has no OpenSea dependency at all.
2. **Run `scripts/nftScan.js` against real collections before integrating
   anything.** The selector tables are tuned on reasoning, not on the actual
   contract population of Base and Robinhood Chain. If a drop you know is
   legitimate returns FATAL, the table needs adjusting.

**Then, in order:**

3. **NFT round-trip probe** (`src/risk/nftRoundTripProbe.js`). Port of
   `roundTripProbe.js`: plant probe bytecode at a scratch address via
   `eth_call` state override, mint one, then `safeTransferFrom` to a fresh
   address in the same atomic call. If leg two reverts, we can mint but not
   exit. Zero gas. Neither reference repo has anything like this. Model it on
   `contracts/RoundTripProbe.sol` and `scripts/compileRoundTripProbe.js`.
4. **Fix the circular deployer feedback** in `nftPipeline.js`. It currently
   calls `recordDeployerOutcome(addr, { lowScore: riskResult.score < 40 })`,
   and `scoreDeployerHistory` reads that back to adjust the score. The
   deployer's reputation is defined by our own scorer's output, not by
   whether anything actually rugged. It will converge on something confident
   and unfalsifiable. Use realized outcomes from `nftOutcomeTracker` instead.
   Also add a 7d/30d horizon: the current 24h is right for a flip label,
   too short for a rug label.
5. **Wire the scan into `nftRisk.js`** as a replacement for the
   GoPlus-backed `contractSafety` category. `assessNftContractRisk` caps its
   deduction at 35 specifically so it drops in without rebalancing the other
   three weights.
6. **Tighten `data/nftFilters.json`.** Every threshold is currently a no-op
   (`minRiskScore: 0`, `minOwnerCount: 0`, `maxOwnerConcentrationPercent:
   100`). Only `blockMalicious` is live, and it reads a GoPlus field that is
   null on Robinhood Chain.

---

## Findings that should shape decisions

**`nftRisk.js` is a secondary-market scorer, and a mint bot runs before a
market exists.** Of its four weighted categories, `marketplaceLiquidity` (25)
and `holderDistribution` (20) read floor price, 24h volume, and owner count —
all definitionally zero at mint time. `applyNftFilter` already skips floor and
volume for `source === "new_collection"`, which is the correct patch, but it
means the score collapses to `contractSafety` plus `deployerHistory` plus two
`NO_DATA_FACTOR` defaults.

**GoPlus doesn't cover Robinhood Chain at all**, so `contractSafety` degrades
to a free 10.5 points there. Net: on our primary target chain, the current NFT
scorer is deployer history and padding. This is why Stage A is self-hosted
bytecode analysis with no aggregator dependency.

**`NO_DATA_FACTOR` awards 30% of a category's weight for having learned
nothing.** Unknown should cost points, not earn them. The new module inverts
this and any further work should too.

**`scripts/buildMlDataset.js` has lookahead leakage.** `tokenChangeRatio` is
derived from `currentTokenReserve`, and the label from `currentNativeReserve`
— the same post-hoc snapshot. A pool that drained natively also moved tokens.
`hasLpData` is worse in a subtler way: it's a fact about scraper coverage, not
about the token. Do not train anything on this dataset without fixing both.

**`scripts/extractRugTrainingData.mjs` is clean** — call-time features only,
joined to closed paper trades. That's the good path.

**There are zero NFT rows and zero mint-time features in either dataset.** The
mint-time model starts from nothing. So: deterministic gates carry the bot
from day one, data collection runs in parallel from day one, the learned score
arrives in month three or four. Don't ship a model on 110 token rows from a
four-day window and call it an NFT rug classifier.

**Base rate is 83.6% (530 rows).** Liquidity buckets are flat and
non-monotonic — the *worst* bucket (91% rugged) is in the middle at 1–2
native. At that base rate AUC flatters everything. The metric that matters is
precision at the operating threshold: of the mints we'd have entered, what
fraction paid.

**Rug is three problems, not one.** Hard rug (backdoor, statically
detectable, binary gate), abandonment (clean contract, team walks, only
deployer history predicts it), no demand (80%+ of losers, nobody malicious).
Collapsing them is what makes most detectors mediocre — a static-analysis
hammer on what is mostly a demand-prediction problem.

**Rank features by cost to spoof.** The target adapts: once "fresh wallet
funded ten minutes ago" is a known reject, ruggers age wallets. Cheap to fake:
follower count, verified source, renounced ownership, wallet age. Expensive:
a real record of collections that held floor for 90 days, secondary volume
across independent buyers, a funding graph that avoids known bad clusters.
History is the one thing that's expensive to fake, which is why the deployer
graph is the moat and the feature set isn't.

---

## Conventions to follow

- ES modules, Node ≥22.5, `type: "module"`. Deps: ethers 6, telegraf,
  node-cron, dotenv, `node:sqlite`. Deploys to Railway; SQLite at
  `/data/bot.sqlite` in production.
- **Token and NFT modules stay parallel and independently readable rather
  than sharing helpers.** This is the existing pattern (see the comment in
  `nftRisk.js` about deliberately duplicating `scoreDeployerHistory`). Follow
  it; don't refactor toward shared abstractions.
- **Comments explain why, and cite the real incident.** `sellability.js`
  names SYDNEY, `dangerousFunctions.js` names PONGO / 狗屎运 / DIH,
  `roundTripProbe.js` names MNEMO. Match that standard — a threshold with no
  stated reason is a threshold nobody can safely change later.
- **`honeypot: null` and `checked: false` mean unknown, never safe.** This
  convention is load-bearing across `sellability.js`, `roundTripProbe.js`,
  and the new module. Preserve it in anything new.
- **Budgets are end-to-end, not per-attempt.** Bounding individual calls
  leaves retry backoff unbounded, so a 200ms ceiling silently becomes 3s
  against a fast-failing endpoint. Already fixed in
  `nftDangerousFunctions.js`; don't reintroduce it.
- Telegram messages are hard-capped at 4096 chars and the API rejects the
  *whole* message on overflow or an unbalanced Markdown marker. Cap every
  section and test the pathological case.

## Testing standard

Two bugs made it past review by being invisible without tests, both worth
knowing about because they're easy to repeat:

- The first scan test suite had nine of eleven cases passing **vacuously** —
  the module caches per contract and every case reused one address, so each
  test was served the first case's result. Real caching, fake tests. Every
  case now takes a unique address.
- The URI probe originally looped four candidates sequentially, making
  **pre-reveal contracts the slowest path** — which is every mint we'd
  underwrite. Now batched into round trip 1.

Tests run offline. Provider is stubbed via `mock.module` on `../src/wallet.js`,
so no network, no env, no test-only exports in production code.

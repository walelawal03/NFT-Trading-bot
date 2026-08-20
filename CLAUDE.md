# NFT Mint Underwriter — build context

---

## What we're building and why

An **NFT mint underwriter with an execution arm**. Not a faster sniper.

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

**Neither has discovery, risk filtering, simulation, or exits.** Take
morsy's execution spine, take zunmax's coverage, drop the external
dependency from the critical path.

Target architecture: Ingest → Graph → Underwriter → Executor → Exit engine →
Telegram. Underwriter runs stages cheapest first: (A) bytecode gate,
(B) exit simulation, (C) deployer reputation, (D) demand score.

---

## Repo scope

This repo is the NFT bot and **only** the NFT bot. It was seeded from a token
trading bot ("Degen Assistant Bot"); every token module has been deleted —
pipeline, paper and real trading, watchers, the token risk stack, the swap
executor, the AI rug classifiers, the trade-card and PnL renderers, and their
dataset scripts. The token bot is a separate project at `Trade bot/degenbot`
and is **never** to be edited from here.

If something looks like it wants a token module, it wants the other repo.

---

## What's landed

**`src/risk/nftDangerousFunctions.js`** — Stage A, the deterministic hard
gate.

- 82 selectors across six tables, each computed as `keccak256(sig)[0:4]` and
  verified against published values. Tiered: fatal (seizure, transfer lock),
  deduction (metadata, supply, economics, upgrade), positive (freeze).
- Resolves EIP-1167, EIP-1967, EIP-1822, and beacon proxies.
- Assesses metadata rather than pattern-matching: a `setBaseURI` setter alone
  is normal for delayed reveal. **Mutable setter AND non-content-addressed
  host** is the rug.
- Returns `checked` explicitly. Unknown costs points instead of passing as
  clean.
- One round trip for a plain contract, two for a proxy, three for a beacon.
  Compute is sub-millisecond; latency is entirely network.

**`src/risk/nftRoundTripProbe.js`** — Stage B, the exit simulation. Mints one
and moves it in a single atomic `eth_call` with probe bytecode and a scratch
balance planted by state override. Zero gas, nothing broadcast. The operator
half borrows **Seaport's own address**, because against an arbitrary scratch
operator every validator-gated collection reports blocked — true and useless.
`atTimestamp` block-override lets it answer for a phase that has not opened.
Verdicts: EXITABLE / SOULBOUND / APPROVAL_BLOCKED / OPERATOR_BLOCKED /
NO_DELIVERY / MINT_FAILED / UNKNOWN.

**`src/mint/nftMintDetect.js`** — resolves the mint entrypoint (SeaDrop or
direct), price, phase window, max per wallet, remaining supply, from chain
state alone.

**`src/mint/nftMintExecutor.js` / `mintScheduler.js`** — spend ceiling,
dry-run default, gas estimation, nonce-conflict recovery, multi-wallet
spread. Armed mints prepare and sign 90s ahead against a block-timestamp
override, persist their *intention* (never signatures) across restarts, and
fire on an exact timer inside the last 2s.

**`src/mint/nftHoldings.js`** — the local file is a candidate list, not an
answer; `ownerOf` decides membership, OpenSea widens candidates. Listing
signs with the burner that actually holds the token.

**`src/risk/nftRisk.js`** — four weighted categories; the contract-safety
category is `assessNftContractRisk`, and deployer history reads **realized**
outcomes via `getNftControllerRealizedRecord`.

**`src/telegram/`** — mint card, scan renderer, holdings view, paste handler.
`scripts/nftScan.js` is the read-only CLI.

**Tests** — 164 across 15 suites, all offline, all green.

```bash
TELEGRAM_BOT_TOKEN=x TELEGRAM_CHAT_ID=1 ADMIN_USER_ID=1 \
  node --experimental-test-module-mocks tests/<suite>.test.mjs
```

---

## Outstanding

1. **Replacement-bump / gas escalation.** Armed mints sign once at a single
   gas price. zunmax bumps at 112.5% when the first attempt doesn't land;
   we don't. This is the largest remaining execution gap.
2. **Demand score (Stage D).** Nothing predicts whether anyone will want the
   thing. It is 80%+ of losses and there is currently no signal for it.
3. **The deployer graph.** Funding-graph clustering is the moat and does not
   exist yet.
4. **Multi-endpoint broadcast.** We send to one endpoint per chain; morsy
   blasts all of them and distinguishes dispatched/accepted/mined.

---

## Findings that should shape decisions

**`nftRisk.js` inherited a secondary-market shape, and a mint bot runs
before a market exists.** `marketplaceLiquidity` (25) and
`holderDistribution` (20) read floor price, 24h volume, and owner count —
all definitionally zero at mint time. `applyNftFilter` skips floor and
volume for `source === "new_collection"`, which is correct, but it means the
score collapses to `contractSafety` plus `deployerHistory` plus two
`NO_DATA_FACTOR` defaults.

**GoPlus doesn't cover Robinhood Chain at all**, so `contractSafety` would
degrade to free points there. This is exactly why Stage A is self-hosted
bytecode analysis with no aggregator dependency.

**`NO_DATA_FACTOR` awards 30% of a category's weight for having learned
nothing.** Unknown should cost points, not earn them. `assessNftContractRisk`
and `assessNftRoundTrip` both invert this; anything new should too.

**There are zero NFT rows and zero mint-time features in any dataset.** The
mint-time model starts from nothing. So: deterministic gates carry the bot
from day one, data collection runs in parallel from day one, the learned
score arrives in month three or four. Don't ship a model on a few hundred
rows from a four-day window and call it a rug classifier.

**Rug is three problems, not one.** Hard rug (backdoor, statically
detectable, binary gate), abandonment (clean contract, team walks, only
deployer history predicts it), no demand (80%+ of losers, nobody malicious).
Collapsing them is what makes most detectors mediocre — a static-analysis
hammer on what is mostly a demand-prediction problem.

**Rank features by cost to spoof.** The target adapts: once "fresh wallet
funded ten minutes ago" is a known reject, ruggers age wallets. Cheap to
fake: follower count, verified source, renounced ownership, wallet age.
Expensive: a real record of collections that held floor for 90 days,
secondary volume across independent buyers, a funding graph that avoids
known bad clusters. History is the one thing that's expensive to fake, which
is why the deployer graph is the moat and the feature set isn't.

**A circular scorer is worse than no scorer.** `deployer_history.low_score_count`
was written from our own risk score and read straight back to adjust the next
one — a reputation defined by our previous opinion, never by whether anything
rugged. It converges on something confident and unfalsifiable because reality
is not an input. The table is gone; realized floor movement replaced it. Do
not rebuild it.

---

## Conventions to follow

- ES modules, Node ≥22.5, `type: "module"`. Deps: ethers 6, telegraf,
  node-cron, dotenv, node-fetch, `node:sqlite`. Runs locally under pm2
  (`nftbot`); SQLite at `data/bot.sqlite`.
- **Comments explain why, and cite the real incident.** A threshold with no
  stated reason is a threshold nobody can safely change later. If a comment
  cites a module, make sure that module still exists.
- **`honeypot: null`, `checked: false` and `exitable: null` mean unknown,
  never safe.** Load-bearing across the scan, the probe and the filter.
- **Budgets are end-to-end, not per-attempt.** Bounding individual calls
  leaves retry backoff unbounded, so a 200ms ceiling silently becomes 3s
  against a fast-failing endpoint.
- **`staticNetwork` on every provider is not optional.** Without it an
  unreachable endpoint enters an indefinite "failed to detect network" retry
  loop, and no timeout can rescue it — a budget can only race a promise that
  eventually settles.
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

A third, from the contract-creator cache: a suite that writes to the **real**
`bot.sqlite` passes on a clean database and fails on rerun. Every suite sets
its own `RAILWAY_VOLUME_MOUNT_PATH` to a temp dir. Tests run offline; the
provider is stubbed via `mock.module` on `../src/wallet.js`, so no network,
no env, no test-only exports in production code.

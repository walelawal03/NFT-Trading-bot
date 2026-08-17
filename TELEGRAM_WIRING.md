# Telegram wiring for the NFT capability scan

Three edits to `src/telegram/bot.js`. All additive — nothing existing changes
behaviour.

Why a new command instead of folding it into `/nftscore`: `scoreAndReplyNft`
calls `detectNftChain`, which resolves the collection through OpenSea and
throws if OpenSea hasn't indexed it. That's fine for a secondary-market
score, but it defeats the entire point of the scan, which is that it works
when no aggregator knows the contract exists. `/nftcheck` takes an explicit
chain and never touches OpenSea, GoPlus, or an explorer — so it works on a
Robinhood Chain contract that deployed sixty seconds ago.

---

## 1. Imports

Add near the other `src/risk` and `src/telegram` imports at the top of
`bot.js`:

```js
import { detectNftDangerousFunctions, assessNftContractRisk } from "../risk/nftDangerousFunctions.js";
import { buildNftScanMessage } from "./formatNftScan.js";
```

---

## 2. The handler

Add alongside `scoreAndReplyNft` (around line 995):

```js
// Pure bytecode + storage scan. Deliberately does NOT go through
// detectNftChain: that resolves the collection via OpenSea and throws when
// OpenSea hasn't indexed it, which is exactly the case this exists to
// cover. Chain is explicit or defaults to the first enabled NFT chain.
//
// No OPENSEA_API_KEY gate either, for the same reason — this path has no
// OpenSea dependency, so requiring the key would block the one check that
// still works without it.
async function scanAndReplyNftContract(ctx, contractAddress, chainKeyHint) {
  const chainKey = chainKeyHint || getNftChainKeys()[0];
  if (!CHAINS[chainKey]) {
    throw new Error(`Unknown chain. Options: ${getNftChainKeys().join(", ")}`);
  }
  const chain = { key: chainKey, ...CHAINS[chainKey] };

  const startedAt = Date.now();
  const scan = await detectNftDangerousFunctions(chain, contractAddress, { budgetMs: 8000 });
  const elapsedMs = Date.now() - startedAt;
  const verdict = assessNftContractRisk(scan);

  const message = buildNftScanMessage({ chain, contractAddress, scan, verdict, elapsedMs });
  await ctx.reply(message, { parse_mode: "Markdown", ...backKeyboard() });
}
```

The 8000ms budget is generous on purpose: a human waiting on a Telegram
reply would rather wait two seconds for a real answer than get an instant
UNKNOWN. The tight budgets belong on the automated path, not here.

---

## 3. The command

Add next to the `bot.command("nftscore", ...)` block (around line 2899):

```js
bot.command("nftcheck", async (ctx) => {
  const args = ctx.message.text.split(/\s+/).filter(Boolean).slice(1);
  const usage =
    `Usage: /nftcheck <contractAddress> or /nftcheck <chain> <contractAddress>\n` +
    `Chains: ${getNftChainKeys().join(", ")} (defaults to ${getNftChainKeys()[0]})\n\n` +
    `Static contract scan — no OpenSea, no GoPlus. Works on brand-new contracts.`;

  let chainKeyHint, contractAddress;
  if (args.length === 1) {
    contractAddress = args[0];
  } else if (args.length === 2) {
    [chainKeyHint, contractAddress] = args;
    chainKeyHint = chainKeyHint.toLowerCase();
  } else {
    return ctx.reply(usage);
  }
  if (!contractAddress || !ADDRESS_RE.test(contractAddress)) return ctx.reply(usage);

  await ctx.reply("Reading contract…");
  try {
    await scanAndReplyNftContract(ctx, contractAddress, chainKeyHint);
  } catch (err) {
    ctx.reply(`Scan failed: ${err.message}`);
  }
});
```

---

## 4. The menu button

In `nftMenuKeyboard()` (around line 447), add a row next to Score
Collection:

```js
[Markup.button.callback("🔍 Score Collection", "menu:nftscore"),
 Markup.button.callback("🛡 Contract Scan", "menu:nftcheck")],
```

And the action handler, next to `bot.action("menu:nftscore", ...)` around
line 2806. Follow whatever `setPending` shape that handler uses — it prompts
for an address and routes the reply through `handlePendingAction`. The
matching case in `handlePendingAction` (around line 1490, where
`scoreAndReplyNft` is called) needs a sibling:

```js
case "nftcheck":
  await scanAndReplyNftContract(ctx, text.trim());
  return true;
```

---

## What it looks like

```
✅ CONTRACT SCAN — PASSES HARD GATE on Robinhood Chain

📉 Deduction: 14/35 (contract safety)
🔎 62 selectors read via eip1967 — upgradeable
   ↳ impl 0x1f9840...

🟡 Metadata: medium (ipfs)
  URI setter present but metadata is content-addressed (ipfs)
  ipfs://bafybeic.../1.json

Capabilities found:
  • Supply control (2): devMint(uint256), setMaxSupply(uint256)
  • Metadata setters (1): setBaseURI(string)

Notes:
  • Upgradeable contract (eip1967, impl 0x1f98...) — logic can change after mint
  • Supply controls: devMint(uint256), setMaxSupply(uint256)

Static analysis only: what the owner can do, not what they will. 187ms.
```

And the case that matters most, kept deliberately short so it can't be
misread as a pass at a glance on a phone:

```
⚪️ CONTRACT SCAN — UNKNOWN on Robinhood Chain

Scan exceeded its time budget.
Scan exceeded 8000ms budget at round trip 1

This is not a clean result. Treated as unknown and penalised 17/35.
```

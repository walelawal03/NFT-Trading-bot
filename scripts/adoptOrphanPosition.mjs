// Reconstructs a real position that exists on-chain but has no row in
// real_trades, and writes it in so the tracker picks it up.
//
// This is the manual counterpart to the balance-delta reconciliation now
// built into swapExecutor's buy path. That reconciliation prevents new
// orphans; this cleans up ones already stranded — the first of which was 牛回
// on BNB Chain (2026-08-16), where the buy landed in block 116280313 but the
// receipt could never be read, so the bot filed a successful trade as a
// failure and never tracked the tokens it had just bought.
//
// Everything is derived from the chain and the wallet, never from the caller:
// the entry transaction supplies what was spent and what it cost in gas, and
// the wallet's current balance supplies what is actually held. Only the token
// and its entry tx are taken on trust.
//
// Usage:
//   node scripts/adoptOrphanPosition.mjs <chain> <tokenAddress> <entryTxHash> [--commit]
//
// Runs as a dry run and prints what it would write unless --commit is passed.

import { Contract, formatEther } from "ethers";
import { CHAINS } from "../src/chains.js";
import { getProvider, getWalletAddress } from "../src/wallet.js";
import { getBestPair, pairSummary } from "../src/risk/dexscreener.js";
import { loadRealTradingSettings } from "../src/realTradingSettings.js";
import { openRealTrade, getOpenRealTrades } from "../src/store/db.js";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function name() view returns (string)",
];

const [chainKey, tokenAddress, entryTxHash, ...flags] = process.argv.slice(2);
const commit = flags.includes("--commit");

if (!chainKey || !tokenAddress || !entryTxHash) {
  console.error("usage: node scripts/adoptOrphanPosition.mjs <chain> <tokenAddress> <entryTxHash> [--commit]");
  process.exit(1);
}

const chainDef = CHAINS[chainKey];
if (!chainDef) {
  console.error(`unknown chain "${chainKey}" — known: ${Object.keys(CHAINS).join(", ")}`);
  process.exit(1);
}
const chain = { key: chainKey, ...chainDef };

const walletAddress = getWalletAddress();
if (!walletAddress) {
  console.error("no wallet configured — nothing to reconcile against");
  process.exit(1);
}

const provider = getProvider(chain);

const existing = getOpenRealTrades().find(
  (t) => t.chain === chainKey && t.token_address.toLowerCase() === tokenAddress.toLowerCase()
);
if (existing) {
  console.error(`already tracked as real_trades id=${existing.id} — nothing to adopt`);
  process.exit(1);
}

const [tx, receipt] = await Promise.all([provider.getTransaction(entryTxHash), provider.getTransactionReceipt(entryTxHash)]);
if (!tx || !receipt) {
  console.error(`entry tx ${entryTxHash} not found on ${chainKey}`);
  process.exit(1);
}
if (receipt.status !== 1) {
  console.error(`entry tx ${entryTxHash} reverted (status ${receipt.status}) — there is no position to adopt`);
  process.exit(1);
}
if (tx.from.toLowerCase() !== walletAddress.toLowerCase()) {
  console.error(`entry tx was sent by ${tx.from}, not this bot's wallet ${walletAddress}`);
  process.exit(1);
}

const token = new Contract(tokenAddress, ERC20_ABI, provider);
const [balanceRaw, decimals, symbol, name] = await Promise.all([
  token.balanceOf(walletAddress),
  token.decimals(),
  token.symbol().catch(() => null),
  token.name().catch(() => null),
]);

if (balanceRaw <= 0n) {
  console.error("wallet holds none of this token — nothing to adopt");
  process.exit(1);
}

// The whole native value of the buy transaction, and the gas it actually
// burned, both straight off the chain.
const nativeSpent = Number(formatEther(tx.value));
const gasNative = Number(formatEther(receipt.gasUsed * receipt.gasPrice));
if (nativeSpent <= 0) {
  console.error("entry tx sent no native currency — this doesn't look like a buy");
  process.exit(1);
}

// Native price at entry is long gone, so value the position at today's rate.
// It's the honest option: the alternative is inventing a historical price,
// and every figure below stays internally consistent this way. Same pair and
// same derivation the execution layer uses, so the numbers written here match
// the ones the tracker will compute against them.
const pair = pairSummary(await getBestPair(chain.dexscreenerChainId, tokenAddress), tokenAddress);
const nativeUsdPrice = pair?.nativeUsdPrice || null;
if (!nativeUsdPrice) {
  console.error(`could not price ${chain.nativeSymbol} in USD from this token's pair — rerun when DexScreener responds`);
  process.exit(1);
}

const block = await provider.getBlock(receipt.blockNumber);
const tokenAmountHuman = Number(balanceRaw) / 10 ** Number(decimals);
const usdSpent = nativeSpent * nativeUsdPrice;
const settings = loadRealTradingSettings();

const entry = {
  chain: chainKey,
  tokenAddress,
  symbol: symbol || null,
  name: name || null,
  entryPriceUsd: usdSpent / tokenAmountHuman,
  positionSizeUsd: usdSpent,
  takeProfitPct: settings.takeProfitPct,
  stopLossPct: settings.stopLossPct,
  entryAt: block ? block.timestamp * 1000 : Date.now(),
  tokenAmountRaw: balanceRaw.toString(),
  nativeSpent,
  entryTxHash,
  entryGasUsd: gasNative * nativeUsdPrice,
  entryMarketCapUsd: null,
};

const currentPriceUsd = pair?.priceUsd || null;
const pnlPct = currentPriceUsd != null ? (currentPriceUsd / entry.entryPriceUsd - 1) * 100 : null;

console.log(`\n${symbol || tokenAddress} on ${chain.label}`);
console.log(`  entry tx        ${entryTxHash}`);
console.log(`  mined           block ${receipt.blockNumber}${block ? ` (${new Date(block.timestamp * 1000).toISOString()})` : ""}`);
console.log(`  held            ${tokenAmountHuman.toLocaleString()} ${symbol || "tokens"}`);
console.log(`  spent           ${nativeSpent} ${chain.nativeSymbol} ($${usdSpent.toFixed(4)} at today's rate)`);
console.log(`  gas             ${gasNative} ${chain.nativeSymbol} ($${entry.entryGasUsd.toFixed(4)})`);
console.log(`  entry price     $${entry.entryPriceUsd.toExponential(4)}`);
console.log(`  current price   ${currentPriceUsd != null ? "$" + currentPriceUsd.toExponential(4) : "unknown"}`);
console.log(`  unrealised      ${pnlPct != null ? pnlPct.toFixed(1) + "%" : "unknown"}`);
console.log(`  stop-loss       ${entry.stopLossPct}%   take-profit ${entry.takeProfitPct}%`);

if (pnlPct != null && pnlPct <= entry.stopLossPct) {
  console.log(`\n  NOTE: already past the stop-loss — the tracker will attempt to sell on its next check.`);
}

if (!commit) {
  console.log("\ndry run — rerun with --commit to write this row\n");
  process.exit(0);
}

const res = openRealTrade(entry);
console.log(res.changes === 1 ? "\nadopted — the tracker now owns this position\n" : "\nnot written (a row already existed)\n");
process.exit(0);

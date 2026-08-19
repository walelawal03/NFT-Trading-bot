import { getBestPair, pairSummary } from "../risk/dexscreener.js";

// ETH price in USD, for display only.
//
// Both chains this bot mints on use ETH, so one number serves both. It comes
// from Base's canonical WETH pair via the dexscreener module already in the
// tree rather than a new dependency.
//
// DISPLAY ONLY, and that constraint is load-bearing: nothing about a mint may
// depend on this. It is an off-chain price from a third party, it can be
// stale or missing, and a mint that changed behaviour because a price feed
// hiccuped would be a bug with real money attached. Every caller must render
// "unknown" rather than substitute a guess.
const WETH_BASE = "0x4200000000000000000000000000000000000006";

// Five minutes. ETH does not move enough in that window to change a decision
// about whether 0.03 ETH is affordable, and a mint card should never wait on
// a price API it does not need.
const TTL_MS = 5 * 60 * 1000;

let cached = { usd: null, at: 0 };

export async function getEthUsd() {
  if (cached.usd != null && Date.now() - cached.at < TTL_MS) return cached.usd;
  try {
    const pair = await getBestPair("base", WETH_BASE);
    const usd = pairSummary(pair, WETH_BASE)?.priceUsd ?? null;
    if (usd && usd > 0) cached = { usd, at: Date.now() };
    return cached.usd;
  } catch {
    // Keep whatever was last known rather than dropping to null on one bad
    // fetch — a slightly stale price beats a card that loses its dollar
    // figures every time an API blips.
    return cached.usd;
  }
}

/** `~$12.34`, or empty string when there is no price to show. */
export function usdSuffix(ethAmount, ethUsd) {
  if (ethUsd == null || !Number.isFinite(ethAmount)) return "";
  const usd = ethAmount * ethUsd;
  if (usd === 0) return " (free)";
  return usd < 0.01 ? " (~$0.01)" : ` (~$${usd.toFixed(2)})`;
}

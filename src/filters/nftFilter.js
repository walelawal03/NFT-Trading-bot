import fs from "node:fs";
import path from "node:path";
import { getCollectionStats } from "../risk/opensea.js";
import { getDataDir, seedFileIfMissing } from "../dataDir.js";
import { getWalletTrackRecord } from "../store/db.js";

const filtersPath = path.join(getDataDir(), "nftFilters.json");

// Merged over the persisted file on every load, following the same
// `{ ...DEFAULTS, ...raw }` discipline as the trading-settings loaders.
//
// This is not cosmetic. A volume that already holds an nftFilters.json from
// before these keys existed would read them as undefined, and `undefined &&
// verdict.fatal` is falsy — so the two contract gates would be silently OFF
// on exactly the deployments that have been running longest. A safety gate
// that disappears when a config file is merely old is worse than one that
// was never added. Defaults on, and a persisted false still wins.
// Where minRiskScore: 40 comes from, and what it depends on.
//
// At mint time the score is near-deterministic, because two of the four
// categories have nothing to read: marketplace liquidity is 0 (no floor, no
// volume, not yet safelisted) and holder distribution falls to NO_DATA_FACTOR
// (6/20). So:
//
//     score = (35 - scan deduction) + 0 + 6 + deployerHistory
//
// Against 50 live Base and Robinhood contracts the resulting distribution has
// a clean gap between 39 and 41, and 40 sits in it — rejecting the two fatal
// contracts, the pausable one, both with mutable metadata on a centralised
// host, and the unreadable one. 45 would have rejected 46%, including
// ordinary upgradeable proxies. The number is the gap in the data, not a
// preference.
//
// CAVEAT, and it is a sharp one: deployerHistory is 10 when the controller
// resolves (unproven) and 6 when it cannot. That 4-point shift moves the
// whole baseline from 51 to 47 and, at minRiskScore 40, moves rejection from
// 14% to 44% of the same 50 contracts — without a single contract having
// changed.
//
// This was live for a while. Keyed on the explorer, resolution failed on both
// chains (Etherscan's free plan excludes Base; Blockscout rate-limited
// Robinhood permanently), so the real baseline was 47 and this threshold was
// silently rejecting 44%. Since the key moved to owner() — one eth_call, no
// quota, 8/8 coverage on Robinhood — resolution succeeds, the baseline is 51
// again, and 40 rejects the 14% it was calibrated to. Re-measured 2026-08-18.
//
// So the number to watch is not an API key any more; it is whether
// controllerAddress comes back non-null. If it ever starts returning null in
// bulk, this threshold silently tightens by 30 points of rejection rate.
//
// The two contract gates below do not have this problem: they read the scan
// verdict directly and are independent of the score and of every aggregator.
const DEFAULTS = {
  minFloorPriceEth: 0,
  maxFloorPriceEth: 5,
  minVolume24hEth: 0,
  minOwnerCount: 20,
  maxOwnerConcentrationPercent: 90,
  requireSafelistedOrVerified: false,
  blockMalicious: true,
  blockFatalContract: true,
  blockUnknownContract: true,
  minRiskScore: 40,
  maxCopyTradeBuyEth: 0,
  minCopyTradeBuyEth: 0,
  minWalletSignals: 0,
  minWalletWinRatePercent: 0,
};

export function loadNftFilters() {
  seedFileIfMissing("nftFilters.json");
  if (!fs.existsSync(filtersPath)) return { ...DEFAULTS };
  return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(filtersPath, "utf8")) };
}

export function saveNftFilters(filters) {
  fs.writeFileSync(filtersPath, JSON.stringify(filters, null, 2));
}

const isTrue = (v) => v === "1" || v === 1 || v === true;

// Cheap re-check of floor price right before a buy executes, catching a floor
// collapse in the gap between the original filter pass and the on-chain
// purchase. That gap is not theoretical: a call, a queue wait and a fill can
// be minutes apart, and the number the decision was made on is stale by then.
export async function checkFreshFloorPrice(slug) {
  const filters = loadNftFilters();
  const stats = await getCollectionStats(slug).catch(() => null);
  const floorPriceEth = stats?.floorPriceEth || 0;
  if (filters.maxFloorPriceEth > 0 && floorPriceEth > filters.maxFloorPriceEth) {
    return {
      pass: false,
      floorPriceEth,
      reason: `Floor price jumped to ${floorPriceEth} ETH (above ${filters.maxFloorPriceEth} ETH maximum) since the call`,
    };
  }
  return { pass: true, floorPriceEth };
}

// Decides whether a scored NFT collection gets "called". Returns { pass, reasons }.
//
// Unlike the token filter, this is source-aware: a `new_collection` call
// fires the moment OpenSea indexes a freshly deployed collection, which
// structurally means there's often no secondary-market activity yet (still
// minting) — gating on floor price/volume there doesn't measure risk, it
// just measures "hasn't started trading," and would silently block every
// new-collection call forever the moment someone tightens minFloorPriceEth
// above its 0 default. A `copy_trade` call, by contrast, only ever fires
// because a listing existed and got bought, so a real market is already
// there and those checks are meaningful. Ownership/verification/risk-score
// checks come from mint/deploy-time data either way, so those stay
// unconditional.
export function applyNftFilter(riskResult, { source, triggerBuyPriceEth, triggerWalletAddress } = {}) {
  const filters = loadNftFilters();
  const reasons = [];
  const { security, stats, collection, totalSupply, score } = riskResult;

  if (score < filters.minRiskScore) reasons.push(`Risk score ${score} below minimum ${filters.minRiskScore}`);

  // The bytecode gate, stated as its own reason rather than left to be
  // implied by the score. A fatal verdict already forces the score to 0 in
  // nftRisk.js, so this line changes no decision — it changes the Telegram
  // message from "score 0 below minimum 40", which reads like a data
  // problem, into the specific capability that disqualified the contract.
  const verdict = riskResult.contractVerdict;
  if (filters.blockFatalContract && verdict?.fatal) {
    const why = verdict.flags.filter((f) => f.startsWith("🚨")).join("; ") || "fatal contract capability";
    reasons.push(`Hard contract gate: ${why}`);
  }

  // An unreadable contract is not a safe contract. Separate from the score
  // so it can be turned off independently: on a chain or a bytecode layout
  // the scanner handles badly this would otherwise reject everything, and
  // that failure should be one toggle away rather than a code change.
  if (filters.blockUnknownContract && verdict?.unknown) {
    reasons.push("Contract capability scan came back unknown — not treated as clean");
  }

  if (source !== "new_collection") {
    const floor = stats?.floorPriceEth || 0;
    if (floor < filters.minFloorPriceEth) reasons.push(`Floor price ${floor} ETH below minimum ${filters.minFloorPriceEth} ETH`);
    if (filters.maxFloorPriceEth > 0 && floor > filters.maxFloorPriceEth) {
      reasons.push(`Floor price ${floor} ETH above maximum ${filters.maxFloorPriceEth} ETH`);
    }

    const vol24h = stats?.volume24hEth || 0;
    if (filters.minVolume24hEth > 0 && vol24h < filters.minVolume24hEth) {
      reasons.push(`24h volume ${vol24h} ETH below minimum ${filters.minVolume24hEth} ETH`);
    }
  }

  // Copy-trade-specific quality gate — a wallet buying a near-zero-value
  // item isn't much of a conviction signal. No token-side equivalent (yet):
  // token calls only ever have one trigger source.
  if (source === "copy_trade" && filters.maxCopyTradeBuyEth >= 0) {
    if (triggerBuyPriceEth == null) {
      reasons.push("Copy-trade buy-in price could not be verified as free");
    } else if (triggerBuyPriceEth > filters.maxCopyTradeBuyEth) {
      reasons.push(`Copy-trade buy-in ${triggerBuyPriceEth} ETH above maximum ${filters.maxCopyTradeBuyEth} ETH — free mints only`);
    }
  }
  if (source === "copy_trade" && filters.minCopyTradeBuyEth > 0 && triggerBuyPriceEth != null) {
    if (triggerBuyPriceEth < filters.minCopyTradeBuyEth) {
      reasons.push(`Copy-trade buy-in ${triggerBuyPriceEth} ETH below minimum ${filters.minCopyTradeBuyEth} ETH — too small to treat as a signal`);
    }
  }

  // Wallet track-record gate — only meaningful once a wallet has enough
  // *resolved* signals (see nftOutcomeTracker.js) to say anything; a wallet
  // with fewer than minWalletSignals passes through untouched rather than
  // being auto-rejected for having no history yet — the whole point of
  // tracking is to let a new wallet earn a track record, not lock it out
  // before it can build one. Both fields default to 0 (no-op) since there's
  // no history to gate on until the tracker has run for a while.
  if (source === "copy_trade" && triggerWalletAddress && (filters.minWalletSignals > 0 || filters.minWalletWinRatePercent > 0)) {
    const record = getWalletTrackRecord(triggerWalletAddress);
    // A wallet with zero resolved signals always passes — it hasn't had the
    // chance to build a record yet, and judging it as "0% win rate" would
    // block every newly-added wallet forever the moment
    // minWalletWinRatePercent is set (signals >= 0 is vacuously true under
    // the default minWalletSignals of 0, which is exactly how the earlier
    // version of this gate misfired).
    if (record.signals > 0 && record.signals >= filters.minWalletSignals) {
      const winRatePct = (record.winRate ?? 0) * 100;
      if (winRatePct < filters.minWalletWinRatePercent) {
        reasons.push(`Wallet's copy-trade win rate ${winRatePct.toFixed(0)}% below minimum ${filters.minWalletWinRatePercent}% (${record.signals} tracked signals)`);
      }
    }
  }

  // Ownership checks moved under the same source guard as floor and volume,
  // and for exactly the same reason spelled out above them. A collection
  // still minting has almost no owners and therefore near-100% measured
  // concentration — not because it is concentrated, but because nobody has
  // minted yet. Left unconditional (as these were), raising minOwnerCount
  // above 0 would have silently blocked every new_collection call forever,
  // which is the specific trap that kept all these thresholds pinned at
  // no-op defaults in the first place.
  if (source !== "new_collection") {
    const numOwners = stats?.numOwners ?? 0;
    if (numOwners < filters.minOwnerCount) reasons.push(`Owner count ${numOwners} below minimum ${filters.minOwnerCount}`);

    if (stats?.numOwners != null && totalSupply) {
      const concentrationPct = (1 - stats.numOwners / totalSupply) * 100;
      if (concentrationPct > filters.maxOwnerConcentrationPercent) {
        reasons.push(`Ownership concentration ${concentrationPct.toFixed(0)}% above maximum ${filters.maxOwnerConcentrationPercent}%`);
      }
    }
  }

  if (filters.requireSafelistedOrVerified) {
    const status = collection?.safelistStatus || "not_requested";
    if (status !== "verified" && status !== "approved") reasons.push(`Not verified/approved on OpenSea (status: ${status})`);
  }

  if (filters.blockMalicious && security && isTrue(security.malicious_nft_contract)) {
    reasons.push("Flagged as malicious contract");
  }

  return { pass: reasons.length === 0, reasons, filters };
}

import { getNftSecurity } from "./goplus.js";
import { getContract, getCollection, getCollectionStats } from "./opensea.js";
import { getContractCreator, getDeployerTxCount } from "./explorer.js";
import { getNftDeployerRealizedRecord } from "../store/db.js";
import { detectNftDangerousFunctions, assessNftContractRisk } from "./nftDangerousFunctions.js";

// Same weighting shape as risk/riskScore.js (token side) — contract safety
// carries the most weight, deployer history the least directly-observable
// signal. "Liquidity & lock" becomes "marketplace liquidity" here (floor
// price / volume / OpenSea verification status stand in for DEX liquidity,
// since there's no LP to lock for an NFT collection).
const WEIGHTS = {
  contractSafety: 35,
  marketplaceLiquidity: 25,
  holderDistribution: 20,
  deployerHistory: 20,
};

const NO_DATA_FACTOR = 0.3;

const isTrue = (v) => v === "1" || v === 1 || v === true;

// Wall-clock ceiling for the bytecode scan on the automated path. Tighter
// than the 8s /nftcheck uses on purpose: a human waiting on a Telegram reply
// would rather wait two seconds for a real answer, but the pipeline is
// scoring every collection the watcher sees and cannot spend that per
// candidate. One round trip for a plain contract, two for a proxy — 2.5s is
// several times the observed 270-950ms even on a cold proxy.
const SCAN_BUDGET_MS = 2500;

// Contract safety is now read from the contract itself.
//
// It used to come from GoPlus, which does not cover Robinhood Chain at all —
// nft_security returns null there, the category fell through to
// NO_DATA_FACTOR, and the primary target chain scored a free 10.5 points for
// nothing. A bytecode scan has no such gap: it is plain eth_call/eth_getCode
// and works identically on any EVM chain, including a contract deployed
// sixty seconds ago that no aggregator has indexed.
//
// assessNftContractRisk caps its deduction at exactly WEIGHTS.contractSafety
// so it drops in here without rebalancing the other three categories.
//
// GoPlus is kept as an ADDITIONAL fatal signal where it does answer. It can
// only ever take points away now — its absence awards nothing, which is the
// whole point of the change.
function scoreContractSafety(scanVerdict, sec, flags) {
  if (isTrue(sec?.malicious_nft_contract)) {
    flags.push("🚨 Flagged as a malicious contract — score forced to 0");
    return { points: 0, fatal: true };
  }

  for (const f of scanVerdict.flags) flags.push(f);

  const points = Math.max(0, WEIGHTS.contractSafety - scanVerdict.deduction);
  return { points, fatal: scanVerdict.fatal };
}

function scoreMarketplaceLiquidity(collection, stats, flags) {
  let points = 0;

  const status = collection?.safelistStatus || "not_requested";
  if (status === "verified") points += 10;
  else if (status === "approved") points += 6;
  else if (status === "requested") points += 2;
  else flags.push("Not verified/approved on OpenSea");

  const floor = stats?.floorPriceEth || 0;
  if (floor >= 1) points += 8;
  else if (floor >= 0.1) points += 5;
  else if (floor > 0) points += 2;
  else flags.push("No floor price yet (no active listings)");

  const vol24h = stats?.volume24hEth || 0;
  if (vol24h >= 5) points += 7;
  else if (vol24h >= 1) points += 4;
  else if (vol24h > 0) points += 1;
  else flags.push("No 24h trading volume");

  return Math.min(WEIGHTS.marketplaceLiquidity, points);
}

function scoreHolderDistribution(stats, totalSupply, flags) {
  if (!stats || stats.numOwners == null || !totalSupply) return WEIGHTS.holderDistribution * NO_DATA_FACTOR;

  let points = 0;
  const ratio = stats.numOwners / totalSupply;
  if (ratio >= 0.6) points += 12;
  else if (ratio >= 0.3) points += 7;
  else if (ratio >= 0.1) points += 3;
  else flags.push(`Highly concentrated ownership (${stats.numOwners} owners / ${totalSupply} supply)`);

  if (stats.numOwners >= 500) points += 8;
  else if (stats.numOwners >= 100) points += 5;
  else if (stats.numOwners >= 20) points += 2;
  else flags.push(`Only ${stats.numOwners} owners`);

  return Math.min(WEIGHTS.holderDistribution, points);
}

// Identical logic to riskScore.js's scoreDeployerHistory — deliberately
// duplicated rather than shared, matching this codebase's existing pattern
// of parallel token/NFT (and paper/real trading) modules that stay
// independently readable rather than sharing a common helper.
async function scoreDeployerHistory(chain, contractAddress, flags) {
  const creation = await getContractCreator(chain, contractAddress).catch(() => ({
    ok: false,
    reason: "error",
  }));

  if (!creation.ok) {
    if (creation.reason === "unsupported_chain") {
      flags.push("Deployer history unavailable (chain not covered by Etherscan or Blockscout)");
    } else if (creation.reason !== "no_api_key") {
      flags.push("Deployer history unavailable");
    }
    return { points: WEIGHTS.deployerHistory * NO_DATA_FACTOR, deployerAddress: null };
  }

  // Realized outcomes only. This used to read deployer_history's
  // low_score_count, which nftPipeline.js wrote from THIS function's own
  // output (`lowScore: riskResult.score < 40`) — a closed loop in which the
  // deployer's reputation was our previous opinion of them rather than
  // anything that happened on-chain. It could never be contradicted by
  // evidence, so it would settle into confident nonsense.
  //
  // A drawdown at or past -60% is the starting line for "rugged". It is
  // well outside ordinary post-mint floor noise, and it deliberately does
  // not try to separate hard rug from abandonment from no-demand — from a
  // holder's side those are the same event, and only the first is even
  // visible to static analysis. Treat the number as unvalidated: there are
  // no NFT outcome rows yet, so nothing has tuned it. Revisit once there
  // are enough resolved collections to look at the distribution.
  const record = getNftDeployerRealizedRecord(creation.deployerAddress, { ruggedBelowPct: -60 });
  let points = WEIGHTS.deployerHistory;

  if (record.collections === 0) {
    // No settled history is not a good history, so it cannot earn the full
    // category. Three rungs, deliberately ordered: deployer unidentifiable
    // scores NO_DATA_FACTOR (6/20, above), identified-but-unproven scores
    // half (10/20, here), and a clean settled record scores 20. Leaving
    // unproven at 20 — which is what this did — meant every deployer alive
    // started at maximum and the category could only ever punish, never
    // distinguish. At mint time that is the common case, so it also inflated
    // exactly the scores a mint-time filter has to threshold on.
    points = Math.round(WEIGHTS.deployerHistory * 0.5);
    flags.push("Deployer has no collections with a settled outcome yet — unproven, not clean");
  } else if (record.ruggedRatio > 0.5) {
    points = 2;
    flags.push(`Deployer: ${record.rugged}/${record.collections} prior collections down 60%+ after the call`);
  } else if (record.ruggedRatio > 0.2) {
    points -= 10;
    flags.push(`Deployer: ${record.rugged}/${record.collections} prior collections down 60%+ after the call`);
  } else {
    flags.push(
      `Deployer: ${record.collections} prior collection(s) settled, none rugged (avg ${record.avgPct.toFixed(0)}%)`
    );
  }

  const chainStats = await getDeployerTxCount(chain, creation.deployerAddress).catch(() => null);
  if (chainStats && chainStats.contractCreations > 15) {
    points -= 6;
    flags.push(`Deployer has created ${chainStats.contractCreations} contracts (serial deployer)`);
  }

  return { points: Math.max(0, points), deployerAddress: creation.deployerAddress };
}

function gradeFor(score) {
  if (score >= 80) return { grade: "A", label: "Very Low Risk" };
  if (score >= 60) return { grade: "B", label: "Low Risk" };
  if (score >= 40) return { grade: "C", label: "Medium Risk" };
  if (score >= 20) return { grade: "D", label: "High Risk" };
  return { grade: "F", label: "Extreme Risk — likely scam" };
}

// chain must carry goplusChainId/etherscanChainId like the token-side chain
// objects — NFT support currently covers Base and Robinhood Chain (see
// nftChains.js), fully chain-parameterized the same way riskScore.js is.
// Note: GoPlus doesn't cover Robinhood Chain at all (confirmed in
// riskScore.js's goplusUnsupported handling) — nft_security calls there
// fail closed to null and this degrades to NO_DATA_FACTOR automatically.
export async function computeNftRiskScore(chain, contractAddress) {
  const flags = [];

  const contractInfo = await getContract(chain.key, contractAddress).catch(() => null);
  const slug = contractInfo?.slug || null;
  if (!slug) flags.push("⚠️ Could not resolve an OpenSea collection for this contract — marketplace data unavailable");

  // The scan runs alongside the aggregator lookups rather than after them:
  // it depends on nothing they return, and it is the one source here that
  // still answers when OpenSea and GoPlus don't.
  const [security, collection, scan] = await Promise.all([
    getNftSecurity(chain.goplusChainId, contractAddress).catch(() => null),
    slug ? getCollection(slug).catch(() => null) : null,
    detectNftDangerousFunctions(chain, contractAddress, { budgetMs: SCAN_BUDGET_MS }).catch(() => null),
  ]);
  const stats = slug ? await getCollectionStats(slug).catch(() => null) : null;

  const name = collection?.name || contractInfo?.name || null;
  const totalSupply = collection?.totalSupply ?? null;

  // A thrown scan is not a clean scan. assessNftContractRisk already treats
  // checked:false as unknown-and-penalised, so hand it a shaped failure
  // rather than letting a null quietly skip the category.
  const scanVerdict = assessNftContractRisk(
    scan ?? { checked: false, reason: "Contract scan threw", timedOut: false }
  );
  const { points: contractSafety, fatal } = scoreContractSafety(scanVerdict, security, flags);
  const marketplaceLiquidity = scoreMarketplaceLiquidity(collection, stats, flags);
  const holderDistribution = scoreHolderDistribution(stats, totalSupply, flags);
  const { points: deployerHistory, deployerAddress } = await scoreDeployerHistory(chain, contractAddress, flags);

  const total = fatal ? 0 : Math.round(contractSafety + marketplaceLiquidity + holderDistribution + deployerHistory);
  const { grade, label } = gradeFor(total);

  return {
    score: total,
    grade,
    label,
    breakdown: {
      contractSafety: Math.round(contractSafety),
      marketplaceLiquidity: Math.round(marketplaceLiquidity),
      holderDistribution: Math.round(holderDistribution),
      deployerHistory: Math.round(deployerHistory),
    },
    flags,
    name,
    slug,
    imageUrl: collection?.imageUrl || null,
    totalSupply,
    security,
    collection,
    stats,
    deployerAddress,
    // The raw scan and its verdict, so the filter can reject on a specific
    // capability rather than only on the aggregate score, and so Telegram
    // can show what was actually found in the bytecode.
    contractScan: scan,
    contractVerdict: scanVerdict,
  };
}

import { getNftSecurity } from "./goplus.js";
import { getContract, getCollection, getCollectionStats } from "./opensea.js";
import { getContractCreator, getDeployerTxCount } from "./explorer.js";
import { Contract } from "ethers";
import { getProvider } from "../wallet.js";
import { getNftControllerRealizedRecord } from "../store/db.js";
import { detectNftDangerousFunctions, assessNftContractRisk } from "./nftDangerousFunctions.js";

// Contract safety carries the most weight, deployer history the least
// directly-observable signal. The shape is inherited from the token scorer
// this repo was seeded from, where the second category was "liquidity &
// lock"; here it is "marketplace liquidity" — floor price, volume and
// OpenSea verification status stand in for DEX liquidity, since there is no
// LP to lock for an NFT collection.
const WEIGHTS = {
  contractSafety: 35,
  marketplaceLiquidity: 25,
  holderDistribution: 20,
  deployerHistory: 20,
};

const NO_DATA_FACTOR = 0.3;

const isTrue = (v) => v === "1" || v === 1 || v === true;
const ONCHAIN_META_ABI = [
  "function name() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function maxTotalSupply() view returns (uint256)",
];

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

  if (collection?.createdDate) {
    const created = Date.parse(collection.createdDate);
    if (Number.isFinite(created)) {
      const ageMs = Date.now() - created;
      if (ageMs < 60 * 60 * 1000) {
        flags.push("Collection is less than 1 hour old");
      } else if (ageMs < 24 * 60 * 60 * 1000) {
        points += 2;
        flags.push("Collection is less than 24 hours old");
      } else if (ageMs < 7 * 24 * 60 * 60 * 1000) {
        points += 4;
      } else if (ageMs < 30 * 24 * 60 * 60 * 1000) {
        points += 6;
      } else {
        points += 8;
      }
    }
  }

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

// Who controls this collection, asked of the contract rather than of an
// indexer.
//
// The reputation key used to be the deployer, from Etherscan/Blockscout.
// That does not work here. Etherscan's free plan does not cover Base, and
// unauthenticated Blockscout allows ~10 requests per ~26 minute window per
// host while the collection watcher can hand over 100+ contracts from a
// single poll — so on Robinhood, the primary target chain, the lookup was
// permanently rate-limited and the reputation graph collected nothing.
//
// owner() is one eth_call. No key, no quota, no indexer, and it answers for
// a contract deployed sixty seconds ago — the same property that makes the
// bytecode scan the backbone of this bot. Measured coverage on live
// contracts (2026-08-18): 8/8 on Robinhood, 5/8 on Base, where all three
// misses were Uniswap/Pancake/Aerodrome position NFTs — infrastructure, not
// collections anyone would underwrite.
//
// It is a DIFFERENT key from the deployer, not a cheaper route to the same
// one. Ownership transfers; deployment doesn't. For underwriting that trade
// is worth making: the question is who can pull the levers on this drop
// now, not who compiled it. But the two must never be pooled into one
// reputation record, which is why the kind is stored alongside the address
// and matched on.
const OWNER_ABI = [
  "function owner() view returns (address)",
  "function getOwner() view returns (address)",
  "function admin() view returns (address)",
];
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

async function resolveController(chain, contractAddress, flags) {
  const c = new Contract(contractAddress, OWNER_ABI, getProvider(chain));

  // All three concurrently: ethers coalesces them into one batched request,
  // so the common case costs a single round trip rather than three.
  const [owner, getOwner, admin] = await Promise.all([
    c.owner().catch(() => null),
    c.getOwner().catch(() => null),
    c.admin().catch(() => null),
  ]);
  const found = [owner, getOwner, admin].find((a) => typeof a === "string" && /^0x[0-9a-fA-F]{40}$/.test(a));

  if (found && found !== ZERO_ADDRESS) return { address: found, kind: "owner" };

  if (found === ZERO_ADDRESS) {
    // Renounced. Deliberately worth NO points: CLAUDE.md ranks renounced
    // ownership among the cheap-to-fake signals, and renouncing after a
    // backdoor is already in the bytecode changes nothing. Recorded because
    // it explains why there is no owner key, not as a virtue.
    flags.push("Ownership renounced — no owner to build a record against");
  }

  // Fall back to the indexer. It still works on chains Etherscan covers on
  // the free plan, and something is better than nothing when a contract
  // exposes no ownership accessor at all.
  const creation = await getContractCreator(chain, contractAddress).catch(() => ({ ok: false, reason: "error" }));
  if (creation.ok) return { address: creation.deployerAddress, kind: "deployer" };

  if (creation.reason === "rate_limited") flags.push("Deployer lookup rate-limited by the explorer");
  else if (creation.reason === "unsupported_chain") flags.push("Deployer history unavailable (chain not covered by Etherscan or Blockscout)");
  else if (creation.reason !== "no_api_key") flags.push("No owner accessor and no deployer record");
  return null;
}

async function readOnChainMeta(chain, contractAddress) {
  const contract = new Contract(contractAddress, ONCHAIN_META_ABI, getProvider(chain));
  const [name, totalSupply, maxSupplyAnswer] = await Promise.all([
    contract.name().catch(() => null),
    contract.totalSupply().catch(() => null),
    contract
      .MAX_SUPPLY()
      .catch(() => null)
      .then((v) => (v != null ? v : contract.maxSupply().catch(() => null)))
      .then((v) => (v != null ? v : contract.maxTotalSupply().catch(() => null))),
  ]);
  return {
    name,
    totalSupply: totalSupply == null ? null : Number(totalSupply),
    maxSupply: maxSupplyAnswer == null ? null : Number(maxSupplyAnswer),
  };
}

// Reads a controller's REALIZED record — what actually happened to the
// collections they shipped — not our own earlier opinion of them. The
// distinction is the whole point; see getNftControllerRealizedRecord in
// store/db.js for the feedback loop this replaced.
async function scoreDeployerHistory(chain, contractAddress, flags) {
  const controller = await resolveController(chain, contractAddress, flags);

  if (!controller) {
    return { points: WEIGHTS.deployerHistory * NO_DATA_FACTOR, controllerAddress: null, controllerKind: null };
  }
  const creation = { ok: true, deployerAddress: controller.address };

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
  const record = getNftControllerRealizedRecord(controller.address, { kind: controller.kind, ruggedBelowPct: -60 });
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
    flags.push(`${controller.kind === "owner" ? "Owner" : "Deployer"} has no collections with a settled outcome yet — unproven, not clean`);
  } else if (record.ruggedRatio > 0.5) {
    points = 2;
    flags.push(`${controller.kind === "owner" ? "Owner" : "Deployer"}: ${record.rugged}/${record.collections} prior collections down 60%+ after the call`);
  } else if (record.ruggedRatio > 0.2) {
    points -= 10;
    flags.push(`${controller.kind === "owner" ? "Owner" : "Deployer"}: ${record.rugged}/${record.collections} prior collections down 60%+ after the call`);
  } else {
    flags.push(
      `${controller.kind === "owner" ? "Owner" : "Deployer"}: ${record.collections} prior collection(s) settled, none rugged (avg ${record.avgPct.toFixed(0)}%)`
    );
  }

  const chainStats = await getDeployerTxCount(chain, creation.deployerAddress).catch(() => null);
  if (chainStats && chainStats.contractCreations > 15) {
    points -= 6;
    flags.push(`Deployer has created ${chainStats.contractCreations} contracts (serial deployer)`);
  }

  return { points: Math.max(0, points), controllerAddress: controller.address, controllerKind: controller.kind };
}

function gradeFor(score) {
  if (score >= 80) return { grade: "A", label: "Very Low Risk" };
  if (score >= 60) return { grade: "B", label: "Low Risk" };
  if (score >= 40) return { grade: "C", label: "Medium Risk" };
  if (score >= 20) return { grade: "D", label: "High Risk" };
  return { grade: "F", label: "Extreme Risk — likely scam" };
}

// chain must carry goplusChainId/etherscanChainId. Which chains are actually
// watched is nftChains.js — Base and Robinhood Chain today — and nothing here
// is hard-coded to either.
//
// GoPlus does not cover Robinhood Chain at all, so nft_security calls there
// fail closed to null and this degrades to NO_DATA_FACTOR. That is precisely
// why the hard gate is self-hosted bytecode analysis with no aggregator on
// the path: on our primary target chain, the aggregator has nothing to say.
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
  const onchainMeta = await readOnChainMeta(chain, contractAddress).catch(() => null);

  const name = collection?.name || contractInfo?.name || onchainMeta?.name || null;
  const totalSupply = collection?.totalSupply ?? onchainMeta?.totalSupply ?? null;

  // A thrown scan is not a clean scan. assessNftContractRisk already treats
  // checked:false as unknown-and-penalised, so hand it a shaped failure
  // rather than letting a null quietly skip the category.
  const scanVerdict = assessNftContractRisk(
    scan ?? { checked: false, reason: "Contract scan threw", timedOut: false }
  );
  const { points: contractSafety, fatal } = scoreContractSafety(scanVerdict, security, flags);
  const marketplaceLiquidity = scoreMarketplaceLiquidity(collection, stats, flags);
  const holderDistribution = scoreHolderDistribution(stats, totalSupply, flags);
  const { points: deployerHistory, controllerAddress, controllerKind } = await scoreDeployerHistory(chain, contractAddress, flags);

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
    controllerAddress,
    controllerKind,
    // Kept for callers that still read the old name; same value.
    deployerAddress: controllerAddress,
    // The raw scan and its verdict, so the filter can reject on a specific
    // capability rather than only on the aggregate score, and so Telegram
    // can show what was actually found in the bytecode.
    contractScan: scan,
    contractVerdict: scanVerdict,
  };
}

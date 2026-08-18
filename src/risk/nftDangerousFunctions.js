import { Contract } from "ethers";
import { getProvider } from "../wallet.js";
import { extractSelectors } from "./selectorExtraction.js";

// The NFT counterpart to risk/dangerousFunctions.js, and the same core
// question: what can this contract's owner do to us LATER, regardless of
// whether it's armed right now. That module's motivating cases (PONGO,
// 狗屎运, DIH — all sellable at check time, all drained afterwards) apply
// identically here, and matter more for a mint bot, because at mint time
// there is no market to observe at all. floorPriceEth, volume24hEth and
// numOwners — three of the four inputs risk/nftRisk.js scores on — are
// definitionally zero for a collection that hasn't started trading. Static
// capability detection is the only thing that still says anything at T-0.
//
// Everything here is self-hosted bytecode + storage reads. No GoPlus, no
// OpenSea, no explorer. That's deliberate: GoPlus doesn't cover Robinhood
// Chain at all (see riskScore.js's goplusUnsupported handling), so on the
// chain we care most about, every aggregator-backed check degrades to a
// no-data default. This one doesn't.
//
// Three differences from the token-side module, each one a bug we'd
// otherwise inherit:
//
//   1. EIP-1967 and beacon proxies are resolved, not just EIP-1167 clones.
//      The token module resolves clones because a clone reports zero
//      selectors and reads falsely clean. Upgradeable NFT contracts hit
//      the exact same failure and are far more common on the NFT side
//      (thirdweb, Manifold and most launchpad drops deploy behind one).
//      Reading a 1967 proxy's own code finds the fallback stub and nothing
//      else.
//   2. `checked` is returned explicitly. The token module fails open — an
//      RPC error returns empty arrays, which is indistinguishable from
//      "checked, nothing found". For a gate that decides whether to spend
//      money, unknown must never read as clean. Callers gate on `checked`.
//   3. Metadata is inspected, not just pattern-matched. A mutable URI
//      setter alone is not a red flag; most legitimate collections need one
//      for reveal. Mutable setter AND a non-content-addressed host is the
//      actual metadata rug: they keep the option to swap the art for
//      garbage after you've paid. Neither half means much alone, so they're
//      evaluated together (see assessMetadataRisk).

// ── Tier 1a: seizure ────────────────────────────────────────────────────
// Move or destroy a token the holder owns, without the holder. There is no
// ordinary reason for an NFT contract to expose any of these. Fatal.
// (The first five selectors are shared verbatim with the token-side tier 1
// table — same signatures, same hash, independently recomputed here.)
const TIER1_SEIZURE_SELECTORS = {
  "0x33bebb77": "forceTransfer(address,address,uint256)",
  "0xda72c1e8": "adminTransfer(address,address,uint256)",
  "0xa1291f7f": "ownerTransfer(address,address,uint256)",
  "0x2ac05311": "seize(uint256)",
  "0xeb9253c0": "seize(address,uint256)",
  "0x93b49bd3": "confiscate(uint256)",
  "0x47298f82": "confiscate(address,uint256)",
  "0x2dabbeed": "reclaim(uint256)",
  "0xbadb97ff": "adminBurn(uint256)",
  "0x06dd0419": "adminBurn(address,uint256)",
  "0x31c10da3": "forceBurn(uint256)",
  "0xb5f07ea1": "burnFromOwner(uint256)",
  "0x7dc9e79b": "revokeToken(uint256)",
  "0x7d32e793": "recall(uint256)",
};

// ── Tier 1b: transfer lock ──────────────────────────────────────────────
// The NFT honeypot. Not a sell tax (there's no pool to tax) but an outright
// block on moving the token, which means no listing and no exit. Fatal,
// with one deliberate exception noted below.
//
// setOperatorFilteringEnabled is NOT fatal and is scored as tier 2: it's
// OpenSea's own royalty-enforcement registry, shipped by legitimate
// collections, and it restricts which marketplaces can transfer rather than
// blocking transfer outright. Treating it as fatal would reject a large
// share of genuine drops.
const TIER1_TRANSFER_LOCK_SELECTORS = {
  "0x8456cb59": "pause()",
  "0x16c38b3c": "setPaused(bool)",
  "0x36566f06": "togglePaused()",
  "0x26b9ce13": "setTransfersEnabled(bool)",
  "0xc2e5ec04": "setTradingEnabled(bool)",
  "0x3e5ac28f": "toggleTransfers()",
  "0x37b54537": "lockTransfers(bool)",
  "0x35e60bd4": "setTransferLocked(bool)",
  "0xdf30e54b": "setSoulbound(bool)",
  "0x211e28b6": "setLocked(bool)",
  "0xf9f92be4": "blacklist(address)",
  "0x153b0d1e": "setBlacklist(address,bool)",
  "0x44337ea1": "addToBlacklist(address)",
  "0x9cfe42da": "addBlacklist(address)",
  "0x000af2a1": "setBlocked(address,bool)",
  "0x57652a46": "setDenied(address,bool)",
  "0xfe575a87": "isBlacklisted(address)",
};

// ── Metadata control ────────────────────────────────────────────────────
// Presence alone is normal — a delayed reveal needs a URI setter. What
// makes it a rug is the combination with a mutable host; see
// assessMetadataRisk.
const METADATA_CONTROL_SELECTORS = {
  "0x55f804b3": "setBaseURI(string)",
  "0x30176e13": "setBaseTokenURI(string)",
  "0x931688cb": "updateBaseURI(string)",
  "0x02fe5305": "setURI(string)",
  "0x162094c4": "setTokenURI(uint256,string)",
  "0x938e3d7b": "setContractURI(string)",
  "0xda3ef23f": "setBaseExtension(string)",
  "0xf2c4ce1e": "setNotRevealedURI(string)",
  "0xfe2c7fee": "setUnrevealedURI(string)",
  "0x4fdd43cb": "setHiddenMetadataUri(string)",
  "0xa475b5dd": "reveal()",
  "0xe0a80853": "setRevealed(bool)",
  "0x5b8ad429": "toggleReveal()",
};

// The only positive signal in this file. A contract that can permanently
// freeze its own metadata is one whose team thought about the exact attack
// assessMetadataRisk exists to catch. Worth surfacing, but note it's the
// *capability* to freeze, not proof they've used it.
const METADATA_FREEZE_SELECTORS = {
  "0xd111515d": "freezeMetadata()",
  "0xe7bc8208": "freezeBaseURI()",
  "0x989bdbb6": "lockMetadata()",
  "0x5d8c4606": "setMetadataFrozen()",
  "0x5a7256c7": "permanentURI(string,uint256)",
};

// ── Tier 2: supply ──────────────────────────────────────────────────────
// A mint path that bypasses the public cap, or a cap that can be raised
// after you've bought. Not fatal — team allocations are normal and most
// drops reserve some supply — but it dilutes whatever scarcity the mint
// was priced on, so it's a real score deduction.
const SUPPLY_CONTROL_SELECTORS = {
  "0xf19e75d4": "ownerMint(uint256)",
  "0x484b973c": "ownerMint(address,uint256)",
  "0x375a069a": "devMint(uint256)",
  "0x627804af": "devMint(address,uint256)",
  "0x2fbba115": "teamMint(uint256)",
  "0x1342ff4c": "reserveMint(uint256)",
  "0xe58306f9": "adminMint(address,uint256)",
  "0x449a52f8": "mintTo(address,uint256)",
  "0xefbd73f4": "mintForAddress(uint256,address)",
  "0xc204642c": "airdrop(address[],uint256)",
  "0x729ad39e": "airdrop(address[])",
  "0xc0f4af70": "gift(address[],uint256)",
  "0x6f8b44b0": "setMaxSupply(uint256)",
  "0xf103b433": "updateMaxSupply(uint256)",
  "0xb921e163": "increaseSupply(uint256)",
};

// ── Tier 2: economics ───────────────────────────────────────────────────
// Price and royalty levers. setPrice matters specifically for a mint bot in
// a way it doesn't for a secondary buyer: the price we simulate at T-2 is
// not guaranteed to be the price we pay at T-0, so its presence means the
// executor has to re-read price at send time rather than trusting the
// cached value.
const ECONOMIC_CONTROL_SELECTORS = {
  "0x91b7f5ed": "setPrice(uint256)",
  "0xf4a0a528": "setMintPrice(uint256)",
  "0x44a0d68a": "setCost(uint256)",
  "0x8d6cc56d": "updatePrice(uint256)",
  "0xe268e4d3": "setMaxPerWallet(uint256)",
  "0xafdf6134": "setMaxMintPerWallet(uint256)",
  "0xc6f6f216": "setMaxPerTx(uint256)",
  "0x04634d8d": "setDefaultRoyalty(address,uint96)",
  "0x02fa7c47": "setRoyaltyInfo(address,uint96)",
  "0xc21b471b": "setRoyalties(address,uint96)",
  "0xaa1b103f": "deleteDefaultRoyalty()",
  "0x7cb64759": "setMerkleRoot(bytes32)",
  "0xbdeb7a85": "setAllowListRoot(bytes32)",
  "0xb7c0b8e8": "setOperatorFilteringEnabled(bool)",
};

// Explicit upgrade entrypoints. Distinct from the storage-slot proxy
// detection below: this catches a contract that exposes an upgrade path in
// its own code, the slot read catches one that's already behind a proxy.
// Either way every other finding in this report becomes provisional, since
// the logic can be swapped after we buy.
const UPGRADE_SELECTORS = {
  "0x3659cfe6": "upgradeTo(address)",
  "0x4f1ef286": "upgradeToAndCall(address,bytes)",
  "0xd784d426": "setImplementation(address)",
  "0x0900f010": "upgrade(address)",
};

// Minimal-proxy templates. Every one of these bakes a single implementation
// address into its own runtime code and has no setter, so all are immutable
// — resolving them is about reading the right code, not upgradeability.
//
// The token-side module knows only the canonical 45-byte EIP-1167 template.
// That is not enough here: AMEX PASSPORT (0x96cebb59..., Base, 3.5M supply)
// is a 44-byte Solady LibClone proxy, and against a canonical-only match it
// resolved to nothing, extracted 0 selectors, and scored UNKNOWN at 17/35 —
// a live collection reading as unscannable, including a freezeMetadata()
// it could not see.
//
// Measured prevalence in a 51-contract live sample (2026-08-18): 1/29 on
// Base, 0/22 on Robinhood, against 1 and 9 canonical clones respectively.
// So this is an uncommon template, not a dominant one — it earns its row
// because the failure is silent and total, not because it is frequent.
//
// Both templates are the same delegatecall-and-return-everything semantics;
// Solady's saves a byte with a different opcode prelude. Matching is exact
// on length, prefix and suffix, so a contract that merely happens to start
// with these bytes cannot be mistaken for a clone.
const CLONE_TEMPLATES = [
  // EIP-1167 canonical — 45 bytes.
  { via: "eip1167", prefix: "363d3d373d3d3d363d73", suffix: "5af43d82803e903d91602b57fd5bf3" },
  // Solady LibClone — 44 bytes.
  { via: "eip1167_solady", prefix: "3d3d3d3d363d3d37363d73", suffix: "5af43d3d93803e602a57fd5bf3" },
];

// EIP-1967 standard slots (keccak256(label) - 1) and EIP-1822's PROXIABLE
// slot. Computed, not copied — verify with:
//   keccak256("eip1967.proxy.implementation") - 1
const SLOT_EIP1967_IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const SLOT_EIP1967_BEACON = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const SLOT_EIP1822_PROXIABLE = "0xc5f16f0fcc639fa48a6947836d9850f504798523bf8c9a3a87d5876cf622bcf7";

const BEACON_ABI = ["function implementation() view returns (address)"];
const URI_ABI = [
  "function tokenURI(uint256) view returns (string)",
  "function uri(uint256) view returns (string)",
];

const ZERO_WORD = "0x" + "0".repeat(64);

function addressFromSlot(word) {
  if (!word || word === ZERO_WORD) return null;
  const addr = "0x" + word.slice(-40);
  return /^0x0{40}$/.test(addr) ? null : addr;
}

// Returns { address, via } for a recognised minimal proxy, else null. The
// expected length is derived from each template rather than hardcoded, so
// adding a variant is one row above and nothing here.
function resolveCloneTarget(bytecodeHex) {
  const hex = bytecodeHex.slice(2).toLowerCase();
  for (const { via, prefix, suffix } of CLONE_TEMPLATES) {
    if (hex.length !== prefix.length + 40 + suffix.length) continue;
    if (!hex.startsWith(prefix) || !hex.endsWith(suffix)) continue;
    return { address: "0x" + hex.slice(prefix.length, prefix.length + 40), via };
  }
  return null;
}

// Reads a live token URI to find out where metadata actually points. Four
// candidates because collections disagree about whether they're 0-indexed,
// ERC1155 uses uri() instead of tokenURI(), and a pre-reveal contract
// reverts for ids that don't exist yet.
//
// All four are issued in the round-trip-1 batch below, not in a loop.
// Sequentially they cost
// four round trips whenever the first candidate misses, which is the common
// case for exactly the contracts we care most about — a mint we're
// underwriting is pre-reveal by definition, so tokenURI(1) reverts and we
// pay full RTT three more times before learning anything. Concurrently
// they're one round trip, and ethers' JsonRpcProvider coalesces them into a
// single batched HTTP request on top of that.
//
// Preference order is preserved by index, not by arrival: whichever
// candidate resolves first in wall-clock time is irrelevant, we want
// tokenURI over uri and id 1 over id 0 deterministically, so the same
// contract always yields the same URI.
//
// Returns scheme: "ipfs" | "arweave" | "data" | "http" | "unknown".
const URI_CANDIDATES = [
  ["tokenURI", 1n],
  ["tokenURI", 0n],
  ["uri", 1n],
  ["uri", 0n],
];

// ── Round trip 1 ────────────────────────────────────────────────────────
// Everything that depends on nothing but `address`: its code, all three
// proxy slots, and all four token-URI candidates. Eight reads, issued
// together, so ethers coalesces them into ONE batched HTTP request and the
// whole thing costs a single network round trip.
//
// This deliberately reads the proxy slots on every contract, including
// plain ones where all three come back zero. Sequencing them behind the
// EIP-1167 string test (which is what the token-side module does, correctly
// for its purposes) would save three cheap reads and cost a full round
// trip. At 150ms RTT that trade is about 150x in the wrong direction: RPC
// reads are nearly free, latency is the entire budget.
//
// Nothing here can be collapsed further. Fetching the implementation's code
// requires knowing the implementation address, which requires this batch to
// have returned. That dependency is the floor on how fast this can be.
async function fetchBase(provider, address) {
  const c = new Contract(address, URI_ABI, provider);
  const [code, implWord, beaconWord, proxiableWord, ...uris] = await Promise.all([
    provider.getCode(address),
    provider.getStorage(address, SLOT_EIP1967_IMPL).catch(() => null),
    provider.getStorage(address, SLOT_EIP1967_BEACON).catch(() => null),
    provider.getStorage(address, SLOT_EIP1822_PROXIABLE).catch(() => null),
    ...URI_CANDIDATES.map(([fn, id]) => c[fn].staticCall(id).catch(() => null)),
  ]);

  let uri = null;
  for (const u of uris) {
    if (typeof u === "string" && u.length > 0) { uri = u; break; }
  }
  return { code, implWord, beaconWord, proxiableWord, uri };
}

// ── Round trip 2 (and 3, for beacons) ───────────────────────────────────
// Only runs when round trip 1 proved this is a proxy. A plain contract
// never gets here, which is why the common path is one round trip total.
async function resolveImplementation(provider, address, base) {
  const own = base.code;
  if (own === "0x") return { code: "0x", via: "eoa", implementation: null, upgradeable: false };

  const clone = resolveCloneTarget(own);
  if (clone) {
    // A clone is immutable — it delegates to one fixed address baked into
    // its own bytecode and there is no setter. Resolving it is about
    // reading the right code, not about upgradeability.
    return {
      code: await provider.getCode(clone.address),
      via: clone.via,
      implementation: clone.address,
      upgradeable: false,
    };
  }

  const impl = addressFromSlot(base.implWord) || addressFromSlot(base.proxiableWord);
  if (impl) {
    const via = addressFromSlot(base.implWord) ? "eip1967" : "eip1822";
    return { code: await provider.getCode(impl), via, implementation: impl, upgradeable: true };
  }

  const beacon = addressFromSlot(base.beaconWord);
  if (beacon) {
    // Beacon proxies are the worst case for us, and the only three-round-
    // trip path: the implementation isn't in this contract's storage, it's
    // in a shared beacon the drop's team may not even control. One beacon
    // upgrade changes every collection pointing at it, including after
    // we've bought. Two dependent hops (beacon address → implementation
    // address → its code) that cannot be parallelised.
    const target = await new Contract(beacon, BEACON_ABI, provider).implementation().catch(() => null);
    if (target) {
      return { code: await provider.getCode(target), via: "beacon", implementation: target, upgradeable: true };
    }
    return { code: own, via: "beacon_unresolved", implementation: beacon, upgradeable: true };
  }

  return { code: own, via: "direct", implementation: null, upgradeable: false };
}

function classifyUri(uri) {
  if (!uri) return { scheme: "unknown", contentAddressed: null };
  const u = uri.trim().toLowerCase();
  if (u.startsWith("ipfs://") || u.includes("/ipfs/")) return { scheme: "ipfs", contentAddressed: true };
  if (u.startsWith("ar://") || u.includes("arweave.net/")) return { scheme: "arweave", contentAddressed: true };
  if (u.startsWith("data:")) return { scheme: "data", contentAddressed: true };
  if (u.startsWith("http://") || u.startsWith("https://")) return { scheme: "http", contentAddressed: false };
  return { scheme: "unknown", contentAddressed: null };
}

// The metadata rug needs BOTH halves and neither one alone means much:
//
//   mutable setter + content-addressed host   → they can repoint, but the
//       old CID stays valid and anyone can pin it. Survivable.
//   immutable + centralised host              → they can change what the
//       server returns, but a freeze capability or a renounced owner
//       constrains it. Weak signal on its own.
//   mutable setter + centralised host         → they hold a live option to
//       swap the art for anything, at any time, for free. This is the rug.
//
// Gating on the setter alone would reject most legitimate delayed-reveal
// drops, which is exactly the false-positive mode that made
// bytecodeAnalysis.js unusable on the token side.
function assessMetadataRisk({ hasMutableUri, hasFreeze, uri }) {
  const { scheme, contentAddressed } = classifyUri(uri);

  if (!hasMutableUri) {
    return { level: "low", scheme, uri, reason: "No URI setter found in bytecode" };
  }
  if (contentAddressed === true) {
    return {
      level: hasFreeze ? "low" : "medium",
      scheme,
      uri,
      reason: `URI setter present but metadata is content-addressed (${scheme})${hasFreeze ? " and the contract can freeze it" : ""}`,
    };
  }
  if (contentAddressed === false) {
    return {
      level: "high",
      scheme,
      uri,
      reason: "Mutable URI setter AND metadata served from a centralised host — the art can be swapped after purchase",
    };
  }
  return {
    level: "unknown",
    scheme,
    uri,
    reason: uri ? "URI scheme unrecognised" : "Could not read a token URI (likely pre-reveal or non-standard)",
  };
}

const cache = new Map();

function matched(selectors, table) {
  return selectors.filter((s) => table[s]).map((s) => table[s]);
}

// Default wall-clock ceiling for a cold scan. Two round trips at a
// reasonable RTT, with headroom.
//
// This is a BUDGET, not a prediction. Round-trip count is fixed by the
// dependency chain (see fetchBase) and RTT is a property of the network, so
// no amount of code guarantees a latency number. What the budget guarantees
// is that the caller always gets an answer within it — either a real scan
// or an explicit `checked: false, timedOut: true`, which assessNftContract-
// Risk already treats as unknown-and-penalised rather than clean.
//
// Blowing the budget is a signal in itself. It means the RPC is degraded,
// which is exactly when everything else in the pipeline is least reliable
// and least worth acting on.
const DEFAULT_BUDGET_MS = 2000;

class BudgetExceeded extends Error {
  constructor(stage, ms) {
    super(`${stage} exceeded ${ms}ms budget`);
    this.stage = stage;
    this.budgetExceeded = true;
  }
}

function withBudget(promise, ms, stage) {
  if (ms <= 0) return Promise.reject(new BudgetExceeded(stage, 0));
  let timer;
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    new Promise((_, rej) => {
      timer = setTimeout(() => rej(new BudgetExceeded(stage, ms)), ms);
    }),
  ]);
}

/**
 * Static capability scan of an NFT contract.
 *
 * Returns:
 *   {
 *     checked: boolean,          // false = lookup failed. NEVER treat as clean.
 *     reason: string|null,       // why checked is false
 *     proxy: { via, implementation, upgradeable },
 *     seizure: string[],         // tier 1 — fatal
 *     transferLock: string[],    // tier 1 — fatal
 *     metadataControl: string[],
 *     metadataFreeze: string[],  // positive signal
 *     supplyControl: string[],   // tier 2
 *     economicControl: string[], // tier 2
 *     upgradeEntrypoints: string[],
 *     metadata: { level, scheme, uri, reason },
 *     selectorCount: number,
 *   }
 *
 * Never throws. Callers must gate on `checked` — an unreachable RPC and a
 * genuinely clean contract must not produce the same decision.
 */
export async function detectNftDangerousFunctions(chain, contractAddress, { budgetMs = DEFAULT_BUDGET_MS } = {}) {
  const cacheKey = `${chain.key}:${contractAddress.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const promise = (async () => {
    const provider = getProvider(chain);
    const startedAt = Date.now();

    // Retries for the same reason the token module has them: a transient
    // RPC failure must not look like "checked, nothing found". Cheap,
    // since this runs once per contract and is cached after.
    let lastErr = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const base = await withBudget(
          fetchBase(provider, contractAddress),
          budgetMs - (Date.now() - startedAt),
          "round trip 1"
        );
        const proxy = await withBudget(
          resolveImplementation(provider, contractAddress, base),
          budgetMs - (Date.now() - startedAt),
          "proxy resolution"
        );

        if (proxy.via === "eoa") {
          return {
            checked: false,
            timedOut: false,
            reason: "No contract code at this address",
            proxy,
            seizure: [],
            transferLock: [],
            metadataControl: [],
            metadataFreeze: [],
            supplyControl: [],
            economicControl: [],
            upgradeEntrypoints: [],
            metadata: { level: "unknown", scheme: "unknown", uri: null, reason: "No contract" },
            selectorCount: 0,
          };
        }

        const selectors = extractSelectors(proxy.code);
        const metadataControl = matched(selectors, METADATA_CONTROL_SELECTORS);
        const metadataFreeze = matched(selectors, METADATA_FREEZE_SELECTORS);

        // The URI came from the ORIGINAL address in round trip 1, never
        // the implementation — a proxy's storage is where baseURI actually
        // lives, and calling the implementation directly would read an
        // uninitialised slot and return an empty or wrong URI.
        const uri = base.uri;

        return {
          checked: true,
          timedOut: false,
          reason: null,
          proxy: { via: proxy.via, implementation: proxy.implementation, upgradeable: proxy.upgradeable },
          seizure: matched(selectors, TIER1_SEIZURE_SELECTORS),
          transferLock: matched(selectors, TIER1_TRANSFER_LOCK_SELECTORS),
          metadataControl,
          metadataFreeze,
          supplyControl: matched(selectors, SUPPLY_CONTROL_SELECTORS),
          economicControl: matched(selectors, ECONOMIC_CONTROL_SELECTORS),
          upgradeEntrypoints: matched(selectors, UPGRADE_SELECTORS),
          metadata: assessMetadataRisk({
            hasMutableUri: metadataControl.length > 0,
            hasFreeze: metadataFreeze.length > 0,
            uri,
          }),
          selectorCount: selectors.length,
        };
      } catch (err) {
        lastErr = err;
        // A blown budget is not a transient error and must not be retried.
        if (err?.budgetExceeded) break;

        // The budget is END TO END, not per attempt. Bounding only the
        // individual calls leaves the backoff sleeps unbounded, so an
        // endpoint that fails FAST (403, refused, bad gateway) burns the
        // full 1s + 2s backoff no matter how tight the ceiling — a 200ms
        // budget silently becoming 3s. Found exactly that way against an
        // endpoint returning an instant 403. Retries only happen if
        // there's budget left to spend on them.
        const remaining = budgetMs - (Date.now() - startedAt);
        const backoff = 1000 * (attempt + 1);
        if (attempt >= 2 || remaining <= backoff) break;
        await new Promise((res) => setTimeout(res, backoff));
      }
    }

    console.error(`[nftDangerousFunctions] scan failed for ${contractAddress} after retries:`, lastErr?.message);
    return {
      checked: false,
      timedOut: Boolean(lastErr?.budgetExceeded),
      reason: lastErr?.budgetExceeded
        ? `Scan exceeded ${budgetMs}ms budget at ${lastErr.stage}`
        : `Scan failed: ${lastErr?.message || "unknown error"}`,
      elapsedMs: Date.now() - startedAt,
      proxy: { via: "unknown", implementation: null, upgradeable: false },
      seizure: [],
      transferLock: [],
      metadataControl: [],
      metadataFreeze: [],
      supplyControl: [],
      economicControl: [],
      upgradeEntrypoints: [],
      metadata: { level: "unknown", scheme: "unknown", uri: null, reason: "Scan failed" },
      selectorCount: 0,
    };
  })();

  cache.set(cacheKey, promise);
  return promise;
}

/**
 * Turns a scan into a gate decision plus a point deduction.
 *
 * Two separate outputs on purpose. `fatal` is the hard gate — a
 * deterministic "we cannot exit this" that no amount of hype should
 * override — and it's kept strictly separate from `deduction`, which feeds
 * the numeric score alongside everything else. Collapsing them into one
 * number is how a fatal finding gets outvoted by a high floor price.
 *
 * Deduction is capped at 35 to match nftRisk.js's contractSafety weight, so
 * this can slot in as a replacement for the GoPlus-backed category without
 * rebalancing the other three.
 */
export function assessNftContractRisk(scan) {
  const flags = [];

  if (!scan.checked) {
    // Unknown is not clean. Half the category is withheld rather than
    // granted, the inverse of nftRisk.js's NO_DATA_FACTOR, which currently
    // *awards* 30% of the weight for having learned nothing.
    flags.push(`⚠️ Contract capability scan unavailable (${scan.reason}) — treated as unknown, not safe`);
    return { fatal: false, unknown: true, deduction: 17, flags };
  }

  let deduction = 0;
  let fatal = false;

  if (scan.seizure.length > 0) {
    fatal = true;
    flags.push(`🚨 Seizure capability: ${scan.seizure.join(", ")} — owner can take the NFT back`);
  }
  if (scan.transferLock.length > 0) {
    fatal = true;
    flags.push(`🚨 Transfer can be blocked: ${scan.transferLock.join(", ")} — mintable but potentially unsellable`);
  }

  if (scan.metadata.level === "high") {
    deduction += 12;
    flags.push(`🚩 Metadata rug risk: ${scan.metadata.reason}`);
  } else if (scan.metadata.level === "medium") {
    deduction += 4;
    flags.push(`Metadata is mutable but content-addressed (${scan.metadata.scheme})`);
  } else if (scan.metadata.level === "unknown") {
    deduction += 6;
    flags.push(`Metadata destination unknown: ${scan.metadata.reason}`);
  }

  if (scan.proxy.upgradeable) {
    deduction += 10;
    flags.push(`Upgradeable contract (${scan.proxy.via}, impl ${scan.proxy.implementation}) — logic can change after mint`);
  }
  if (scan.upgradeEntrypoints.length > 0 && !scan.proxy.upgradeable) {
    deduction += 8;
    flags.push(`Upgrade entrypoint in bytecode: ${scan.upgradeEntrypoints.join(", ")}`);
  }

  if (scan.supplyControl.length > 0) {
    deduction += Math.min(8, 3 + scan.supplyControl.length);
    flags.push(`Supply controls: ${scan.supplyControl.join(", ")}`);
  }
  if (scan.economicControl.length > 0) {
    deduction += Math.min(6, 2 + scan.economicControl.length);
    flags.push(`Price/royalty controls: ${scan.economicControl.join(", ")}`);
  }

  if (scan.metadataFreeze.length > 0) {
    deduction = Math.max(0, deduction - 3);
    flags.push(`✅ Can permanently freeze metadata: ${scan.metadataFreeze.join(", ")}`);
  }

  // A contract with almost no selectors is not a simple contract, it's a
  // contract we failed to read — the same falsely-clean failure the clone
  // resolution above exists to prevent, arriving by a different route
  // (unusual dispatcher layout, Vyper, hand-written assembly).
  if (scan.selectorCount < 8) {
    flags.push(`⚠️ Only ${scan.selectorCount} selectors extracted — bytecode may not be readable by this method`);
    return { fatal, unknown: true, deduction: Math.max(deduction, 17), flags };
  }

  return { fatal, unknown: false, deduction: Math.min(35, deduction), flags };
}

/**
 * Warms the cache for contracts we expect to underwrite later.
 *
 * The point of the whole module: a scan that runs when a candidate enters
 * the watchlist costs one or two round trips ONCE, and every lookup after
 * that is a cache hit at zero network cost. Nothing on the mint critical
 * path should ever trigger a cold scan — by T-60 the answer should already
 * be sitting in memory.
 *
 * Concurrency is bounded because a watchlist refresh can be hundreds of
 * contracts and firing them all at once gets the RPC key rate-limited,
 * which produces exactly the checked:false results the scan exists to
 * avoid. Failures are swallowed: a warm attempt that misses just means the
 * later real call pays for it.
 */
export async function prewarmNftScans(chain, contractAddresses, { concurrency = 5, budgetMs } = {}) {
  const queue = [...contractAddresses];
  let warmed = 0;
  const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length > 0) {
      const addr = queue.shift();
      const scan = await detectNftDangerousFunctions(chain, addr, budgetMs ? { budgetMs } : {}).catch(() => null);
      if (scan?.checked) warmed++;
    }
  });
  await Promise.all(workers);
  return { requested: contractAddresses.length, warmed };
}

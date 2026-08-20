import fs from "node:fs";
import path from "node:path";
import { Contract } from "ethers";
import { getDataDir } from "../dataDir.js";
import { getProvider } from "../wallet.js";
import { listMintWallets } from "./mintWallets.js";
import { CHAINS } from "../chains.js";
import { getNftChainKeys } from "../nftChains.js";

// What the mint wallets actually own.
//
// The local file here is a CANDIDATE LIST, not an answer. It records every
// token this bot minted so we know where to look; ownership is then read back
// off the chain itself — `ownerOf` — before anything is shown or listed. That
// split matters because the two ways this can be wrong point in opposite
// directions: a token sold or transferred outside the bot would linger in a
// pure local ledger forever, and a token airdropped or bought elsewhere would
// never appear in one at all. So: the local file answers "which ids to
// check", the chain answers "do we still hold it", and OpenSea (best-effort)
// widens the candidate set to things the bot never touched.
const holdingsPath = () => path.join(getDataDir(), "nftHoldings.json");

const OWNER_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function name() view returns (string)",
];

function readRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(holdingsPath(), "utf8"));
    return Array.isArray(data?.holdings) ? data.holdings : [];
  } catch {
    return [];
  }
}

function writeRaw(holdings) {
  fs.writeFileSync(holdingsPath(), JSON.stringify({ holdings }, null, 2));
}

const keyOf = (h) =>
  `${h.chainKey}:${h.contractAddress.toLowerCase()}:${h.tokenId}:${h.walletAddress.toLowerCase()}`;

/**
 * Records tokens a mint (or buy) delivered.
 *
 * Idempotent on (chain, contract, tokenId, wallet), so re-confirming the same
 * transaction cannot duplicate a row and make one NFT look like two.
 */
export function recordAcquisition({
  chainKey,
  contractAddress,
  walletAddress,
  tokenIds,
  name = null,
  txHash = null,
  pricePaidWei = null,
  source = "mint",
}) {
  if (!tokenIds?.length) return [];
  const existing = readRaw();
  const known = new Set(existing.map(keyOf));
  const added = [];

  for (const tokenId of tokenIds) {
    const row = {
      chainKey,
      contractAddress,
      walletAddress,
      tokenId: String(tokenId),
      name,
      txHash,
      // Stored as a decimal string: JSON has no bigint, and rounding a wei
      // value through a float is how a cost basis quietly stops being the
      // number that was actually paid.
      pricePaidWei: pricePaidWei == null ? null : pricePaidWei.toString(),
      source,
      acquiredAt: Date.now(),
    };
    if (known.has(keyOf(row))) continue;
    known.add(keyOf(row));
    existing.push(row);
    added.push(row);
  }

  if (added.length) writeRaw(existing);
  return added;
}

export function listRecordedHoldings() {
  return readRaw();
}

export function forgetHolding({ chainKey, contractAddress, tokenId, walletAddress }) {
  const existing = readRaw();
  const target = keyOf({ chainKey, contractAddress, tokenId: String(tokenId), walletAddress });
  const next = existing.filter((h) => keyOf(h) !== target);
  if (next.length === existing.length) return false;
  writeRaw(next);
  return true;
}

// Candidates OpenSea knows about for one wallet on one chain. Best-effort in
// every direction: no API key, an unindexed chain, a drop minutes old — all
// of these are normal and must degrade to "nothing extra to add", never to an
// error that hides the tokens we do know about locally.
async function openseaCandidates(chainKey, walletAddress) {
  try {
    const { getAccountNfts } = await import("../risk/opensea.js");
    const nfts = await getAccountNfts(chainKey, walletAddress);
    return nfts.map((n) => ({
      chainKey,
      contractAddress: n.contractAddress,
      walletAddress,
      tokenId: String(n.tokenId),
      name: n.collectionName ?? null,
      source: "opensea",
      txHash: null,
      pricePaidWei: null,
      acquiredAt: null,
    }));
  } catch {
    return [];
  }
}

/**
 * Everything the mint wallets hold, verified on-chain, grouped by collection.
 *
 * `ownerOf` is the only thing that decides membership. A token in the local
 * file that has since been sold drops out; a token OpenSea lists that the
 * wallet no longer holds drops out too.
 *
 * Verification runs concurrently under one end-to-end budget rather than a
 * per-call one. Bounding each call individually leaves a slow chain free to
 * spend that bound once per token, which on a wallet holding thirty is a
 * minute of silence — the same trap already fixed in nftDangerousFunctions.
 */
export async function loadHoldings({ budgetMs = 20000, includeOpensea = true } = {}) {
  const wallets = listMintWallets();
  if (!wallets.length) return { wallets: [], groups: [], checked: true, partial: false };

  const walletSet = new Set(wallets.map((w) => w.address.toLowerCase()));
  const chainKeys = getNftChainKeys();

  const local = readRaw().filter(
    (h) => walletSet.has(h.walletAddress.toLowerCase()) && chainKeys.includes(h.chainKey)
  );

  const remote = includeOpensea
    ? (
        await Promise.all(chainKeys.flatMap((k) => wallets.map((w) => openseaCandidates(k, w.address))))
      ).flat()
    : [];

  // Local first, so its richer fields (tx hash, price paid, mint timestamp)
  // win over the same token seen through OpenSea.
  const candidates = new Map();
  for (const row of [...local, ...remote]) {
    if (!candidates.has(keyOf(row))) candidates.set(keyOf(row), row);
  }
  if (!candidates.size) return { wallets, groups: [], checked: true, partial: false };

  const deadline = Date.now() + budgetMs;
  const providers = new Map();
  const providerFor = (chainKey) => {
    if (!providers.has(chainKey)) providers.set(chainKey, getProvider({ key: chainKey, ...CHAINS[chainKey] }));
    return providers.get(chainKey);
  };
  const remaining = () => Math.max(0, deadline - Date.now());

  let partial = false;
  const verified = await Promise.all(
    [...candidates.values()].map(async (row) => {
      if (remaining() === 0) {
        partial = true;
        return null;
      }
      let timer;
      try {
        const c = new Contract(row.contractAddress, OWNER_ABI, providerFor(row.chainKey));
        const owner = await Promise.race([
          c.ownerOf(row.tokenId),
          new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error("budget")), remaining());
          }),
        ]);
        return String(owner).toLowerCase() === row.walletAddress.toLowerCase() ? row : null;
      } catch {
        // A contract that would not answer is UNKNOWN, not "not held" — but it
        // is also not something to show as a confirmed holding. It is dropped
        // and the caller is told the view is incomplete, the same
        // checked:false convention the risk modules use.
        partial = true;
        return null;
      } finally {
        clearTimeout(timer);
      }
    })
  );

  const held = verified.filter(Boolean);

  const byCollection = new Map();
  for (const row of held) {
    const gk = `${row.chainKey}:${row.contractAddress.toLowerCase()}`;
    if (!byCollection.has(gk)) {
      byCollection.set(gk, {
        chainKey: row.chainKey,
        contractAddress: row.contractAddress,
        name: row.name ?? null,
        tokens: [],
      });
    }
    const group = byCollection.get(gk);
    if (!group.name && row.name) group.name = row.name;
    group.tokens.push(row);
  }

  // Collection names are read once per contract, not once per token: a wallet
  // holding twelve from one drop should cost one call, not twelve.
  await Promise.all(
    [...byCollection.values()].map(async (group) => {
      if (group.name) return;
      const c = new Contract(group.contractAddress, OWNER_ABI, providerFor(group.chainKey));
      group.name = await c.name().catch(() => null);
    })
  );

  for (const group of byCollection.values()) {
    group.tokens.sort((a, b) => {
      const d = BigInt(a.tokenId) - BigInt(b.tokenId);
      return d < 0n ? -1 : d > 0n ? 1 : 0;
    });
  }

  const groups = [...byCollection.values()].sort((a, b) => b.tokens.length - a.tokens.length);
  return { wallets, groups, checked: !partial, partial };
}

/**
 * Attaches a floor price and OpenSea slug to each collection group.
 *
 * Separate from loadHoldings on purpose: ownership is an on-chain fact and
 * must never wait on, or be withheld by, an aggregator. Pricing is the nice
 * part — if OpenSea is down, rate-limited, or has never heard of the drop,
 * the list still renders, just without the money column.
 *
 * Capped at `maxCollections` because OpenSea is globally throttled to roughly
 * one request every 1.1s across this whole process (see risk/opensea.js), and
 * each collection costs two. Twenty collections would be forty-odd seconds of
 * the queue held for a display nicety.
 */
export async function priceHoldings(groups, { maxCollections = 8 } = {}) {
  const { getContract, getCollectionStats } = await import("../risk/opensea.js");

  await Promise.all(
    groups.slice(0, maxCollections).map(async (group) => {
      const info = await getContract(group.chainKey, group.contractAddress).catch(() => null);
      group.slug = info?.slug ?? null;
      if (info?.name && !group.name) group.name = info.name;
      if (!group.slug) return;
      const stats = await getCollectionStats(group.slug).catch(() => null);
      // A floor of 0 is what OpenSea reports when nothing is listed, not a
      // price of zero. Same guard as the mint result card, for the same
      // reason: a zero here would flow into a list-at-floor action.
      // floorEth stays ETH-only, because it is what the portfolio total sums
      // and what the sell buttons price against — adding a USDG amount to an
      // ETH total produces a number that means nothing.
      const floor = stats?.floorPriceEth ?? null;
      group.floorEth = floor != null && floor > 0 ? floor : null;
      // The floor as OpenSea actually quotes it, currency included, so the
      // display can tell "1 USDG" apart from "no floor" — those are very
      // different facts about a collection and the screen should not merge
      // them.
      group.floorRaw = stats?.floorPrice != null && stats.floorPrice > 0 ? stats.floorPrice : null;
      group.floorSymbol = stats?.floorPriceSymbol ?? null;
      group.stats = stats ?? null;
    })
  );

  return groups;
}

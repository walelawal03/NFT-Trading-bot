import { Contract } from "ethers";
import { getProvider } from "../wallet.js";
import { extractSelectors } from "../risk/selectorExtraction.js";
import { detectNftDangerousFunctions } from "../risk/nftDangerousFunctions.js";

// Reads how a collection is actually minted, from the chain and nothing else.
//
// Same discipline as the capability scan next door: no OpenSea, no GoPlus, no
// explorer. A mint we care about is minutes old and no aggregator knows it
// exists yet, so anything on the critical path that isn't an RPC call is a
// dependency that will be down exactly when it matters.
//
// This is read-only. It reports what a mint WOULD cost and when it opens; it
// never sends a transaction and never needs a key.

// SeaDrop 1.0 ships at the same address on every chain OpenSea deploys it to
// (CREATE2, hence the vanity 0x00005EA0 prefix). Verified live on Robinhood
// Chain 2026-08-18: 21,081 bytes of code, and getPublicDrop returned the
// exact phase CASH DOGS (0x904A3F7E...) was advertising — max 3 per wallet,
// opening 2026-08-14T18:00:55Z.
//
// Checksum matters here: the address is CREATE2-derived and the trailing
// "bf5" is lowercase in the canonical form. Passing the wrong case to
// getCode returns 0x and reads as "SeaDrop isn't on this chain".
export const SEADROP_1_0 = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";

const SEADROP_ABI = [
  "function getPublicDrop(address) view returns (tuple(uint80 mintPrice,uint48 startTime,uint48 endTime,uint16 maxTotalMintableByWallet,uint16 feeBps,bool restrictFeeRecipients))",
  "function getAllowedFeeRecipients(address) view returns (address[])",
  "function getCreatorPayoutAddress(address) view returns (address)",
];

// mintSeaDrop is the giveaway. It is the callback SeaDrop invokes on the
// collection and it reverts for anyone else, so a contract exposing it is
// built to be minted THROUGH SeaDrop rather than directly — which means the
// mint transaction goes to SeaDrop, not here. Detecting this wrong sends the
// mint to an address that will revert.
// Every selector below is keccak256(sig)[0:4], computed and checked against
// the live CASH DOGS implementation rather than recalled. Four of the first
// eight written here from memory were wrong, including both SeaDrop ones —
// which would have made SeaDrop detection silently never fire.
const SEL_MINT_SEADROP = "0x64869dad"; // mintSeaDrop(address,uint256)
const SEL_GET_MINT_STATS = "0x840e15d4"; // getMintStats(address)

// Direct-mint entrypoints, in preference order. Almost every non-SeaDrop drop
// is one of these; the quantity-taking forms come first because a bare mint()
// mints exactly one and is the least useful to a batcher.
const DIRECT_MINT_CANDIDATES = [
  { sig: "mint(uint256)", selector: "0xa0712d68", args: ["quantity"] },
  { sig: "publicMint(uint256)", selector: "0x2db11544", args: ["quantity"] },
  { sig: "mintPublic(uint256)", selector: "0xefd0cbf9", args: ["quantity"] },
  { sig: "mint(address,uint256)", selector: "0x40c10f19", args: ["to", "quantity"] },
  { sig: "publicMint(address,uint256)", selector: "0xce6df2b9", args: ["to", "quantity"] },
  { sig: "mint()", selector: "0x1249c58b", args: [] },
];

// Price and per-wallet getters vary by launchpad and none of them is
// standardised. Everything here is optional: a missing getter means unknown,
// which is reported as unknown rather than defaulted to zero. A price that
// silently reads 0 is how you send a mint with no value and eat the revert.
const PRICE_GETTERS = [
  "function mintPrice() view returns (uint256)",
  "function price() view returns (uint256)",
  "function cost() view returns (uint256)",
  "function publicPrice() view returns (uint256)",
  "function PRICE() view returns (uint256)",
];
const MAX_PER_WALLET_GETTERS = [
  "function maxPerWallet() view returns (uint256)",
  "function MAX_PER_WALLET() view returns (uint256)",
  "function maxMintPerWallet() view returns (uint256)",
  "function maxMintsPerWallet() view returns (uint256)",
];
const SALE_ACTIVE_GETTERS = [
  "function saleIsActive() view returns (bool)",
  "function publicSaleActive() view returns (bool)",
  "function mintActive() view returns (bool)",
  "function isPublicSaleActive() view returns (bool)",
];

const BASE_ABI = [
  "function name() view returns (string)",
  "function symbol() view returns (string)",
  "function totalSupply() view returns (uint256)",
  "function maxSupply() view returns (uint256)",
  "function MAX_SUPPLY() view returns (uint256)",
  "function maxTotalSupply() view returns (uint256)",
];

// Tries each candidate getter and returns the first that answers. Reverts are
// the normal case — most contracts implement one name out of five — so a
// rejection here is not an error worth surfacing.
async function firstAnswer(address, provider, abis) {
  for (const abi of abis) {
    const name = abi.match(/function (\w+)\(/)[1];
    const value = await new Contract(address, [abi], provider)[name]().catch(() => null);
    if (value !== null && value !== undefined) return { name, value };
  }
  return null;
}

/**
 * @returns {Promise<{
 *   checked: boolean, reason: string|null,
 *   standard: "seadrop"|"direct"|"unknown",
 *   name: string|null, symbol: string|null,
 *   totalSupply: bigint|null, maxSupply: bigint|null,
 *   soldOut: boolean|null,
 *   phase: {
 *     kind: "public",
 *     priceWei: bigint, startsAt: Date|null, endsAt: Date|null,
 *     maxPerWallet: number|null, feeBps: number|null, live: boolean|null,
 *   }|null,
 *   mintable: boolean|null,   // phase open AND not sold out
 *   mintVia: { target: string, signature: string, note: string }|null,
 *   proxy: object|null,
 * }>}
 */
export async function detectNftMint(chain, contractAddress, { budgetMs = 8000 } = {}) {
  const provider = getProvider(chain);

  // Reuse the capability scan purely for proxy resolution — it is cached per
  // contract, handles EIP-1167 (canonical and Solady), 1967, 1822 and beacon,
  // and this module has no business reimplementing any of it. CASH DOGS is a
  // 45-byte clone whose own bytecode has zero selectors; read the stub and
  // you conclude the collection cannot be minted at all.
  const scan = await detectNftDangerousFunctions(chain, contractAddress, { budgetMs }).catch(() => null);
  const implementation = scan?.proxy?.implementation ?? contractAddress;

  const code = await provider.getCode(implementation).catch(() => "0x");
  if (code === "0x") {
    return { checked: false, reason: "No contract code at this address", standard: "unknown", phase: null, mintable: false, mintVia: null, proxy: scan?.proxy ?? null };
  }
  const selectors = new Set(extractSelectors(code));

  // "Couldn't read it" must never render as "it has no mint function".
  //
  // When the capability scan times out — which Robinhood's public RPC does
  // regularly — implementation falls back to the address itself. For a clone
  // that is a 45-byte stub with zero selectors, so the result was a confident
  // "standard: unknown, no recognised mint entrypoint" for a contract that is
  // in fact a perfectly ordinary SeaDrop drop. Observed live on WASTELAND:
  // one read said unknown with no entrypoint, the next said seadrop with one.
  //
  // A failed resolution plus an unreadably small selector set is a failure to
  // read, and is reported as one.
  const resolutionFailed = !scan || scan.checked === false;
  if (resolutionFailed && selectors.size < 8) {
    return {
      checked: false,
      reason: "Couldn't resolve this contract in time (RPC slow) — retry rather than trusting this",
      standard: "unknown",
      phase: null,
      mintable: null,
      mintVia: null,
      proxy: scan?.proxy ?? null,
    };
  }

  const [name, symbol, totalSupply, maxSupplyAnswer] = await Promise.all([
    new Contract(contractAddress, BASE_ABI, provider).name().catch(() => null),
    new Contract(contractAddress, BASE_ABI, provider).symbol().catch(() => null),
    new Contract(contractAddress, BASE_ABI, provider).totalSupply().catch(() => null),
    firstAnswer(contractAddress, provider, [
      "function maxSupply() view returns (uint256)",
      "function MAX_SUPPLY() view returns (uint256)",
      "function maxTotalSupply() view returns (uint256)",
    ]),
  ]);
  const maxSupply = maxSupplyAnswer?.value ?? null;

  const base = {
    checked: true,
    reason: null,
    name,
    symbol,
    totalSupply: totalSupply ?? null,
    maxSupply,
    soldOut: totalSupply != null && maxSupply != null ? totalSupply >= maxSupply : null,
    proxy: scan?.proxy ?? null,
  };

  // ── SeaDrop ───────────────────────────────────────────────────────────
  if (selectors.has(SEL_MINT_SEADROP) || selectors.has(SEL_GET_MINT_STATS)) {
    const seadrop = new Contract(SEADROP_1_0, SEADROP_ABI, provider);
    const drop = await seadrop.getPublicDrop(contractAddress).catch(() => null);

    if (drop && drop.startTime > 0n) {
      const startsAt = new Date(Number(drop.startTime) * 1000);
      const endsAt = new Date(Number(drop.endTime) * 1000);
      const now = Date.now();
      return {
        ...base,
        standard: "seadrop",
        phase: {
          kind: "public",
          priceWei: drop.mintPrice,
          startsAt,
          endsAt,
          maxPerWallet: Number(drop.maxTotalMintableByWallet),
          feeBps: Number(drop.feeBps),
          // Window only. Whether a mint would actually go through is
          // `mintable` below — a sold-out collection sits inside an open
          // phase and reports live:true, and a bot that acts on that buys a
          // failed transaction.
          live: now >= startsAt.getTime() && now < endsAt.getTime(),
        },
        mintable: now >= startsAt.getTime() && now < endsAt.getTime() && base.soldOut !== true,
        // The mint goes to SeaDrop, NOT to the collection. mintSeaDrop on the
        // collection reverts for every caller except SeaDrop itself.
        mintVia: {
          target: SEADROP_1_0,
          signature: "mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity)",
          note: "SeaDrop — send the mint to SeaDrop, not to the collection",
        },
      };
    }

    // SeaDrop-shaped but no public phase configured. Could be allowlist-only,
    // or a drop that has not been set up yet. Either way it is not "no mint",
    // and saying so beats reporting zero.
    return {
      ...base,
      standard: "seadrop",
      phase: null,
      mintable: false,
      mintVia: { target: SEADROP_1_0, signature: "mintPublic(...)", note: "SeaDrop, but no public phase is configured" },
    };
  }

  // ── Direct mint ───────────────────────────────────────────────────────
  const entry = DIRECT_MINT_CANDIDATES.find((m) => selectors.has(m.selector));
  if (!entry) {
    return { ...base, standard: "unknown", phase: null, mintable: null, mintVia: null };
  }

  const [price, perWallet, active] = await Promise.all([
    firstAnswer(contractAddress, provider, PRICE_GETTERS),
    firstAnswer(contractAddress, provider, MAX_PER_WALLET_GETTERS),
    firstAnswer(contractAddress, provider, SALE_ACTIVE_GETTERS),
  ]);

  return {
    ...base,
    standard: "direct",
    phase: {
      kind: "public",
      // null, never 0. An unknown price sent as zero value is a guaranteed
      // revert at best and an underpay at worst.
      priceWei: price ? price.value : null,
      startsAt: null,
      endsAt: null,
      maxPerWallet: perWallet ? Number(perWallet.value) : null,
      feeBps: null,
      live: active ? Boolean(active.value) : null,
    },
    mintable: active ? Boolean(active.value) && base.soldOut !== true : null,
    mintVia: {
      target: contractAddress,
      signature: entry.sig,
      note: `Direct mint on the collection${price ? ` (price from ${price.name}())` : " (price getter not found)"}`,
    },
  };
}

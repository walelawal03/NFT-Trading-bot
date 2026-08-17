import { getProvider } from "../wallet.js";
import { extractSelectors } from "./selectorExtraction.js";

// Self-hosted substitute for GoPlus's is_proxy/bytecode analysis, used ONLY
// on chains GoPlus has no data for at all (see riskScore.js's
// scoreContractSafety) — GoPlus's own analysis is strictly better where it's
// available, so this never runs alongside it, only in the gap.

// keccak256("eip1967.proxy.implementation") - 1 — the fixed storage slot
// EIP-1967 proxies store their real implementation address in. A nonzero
// value here means the code you're looking at can be swapped out later
// without the contract's address ever changing.
const EIP1967_IMPLEMENTATION_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bb";

// Below this, a contract has too many functions nobody has ever registered a
// signature for to write off as "just an unusually-named template". Used by
// filter.js's blockUnknownBytecode toggle to reject outright. Provisional:
// unlike the numeric filters (backtested across 420 historical calls), this
// has exactly one real data point behind it (catnip/NIP, 6 unknowns) —
// expect to retune once the toggle has run for a while against real calls.
export const UNKNOWN_SELECTOR_REJECT_THRESHOLD = 5;

// Extremely common, unambiguous selectors — skips a network round-trip to
// 4byte.directory for the case every ERC20(+Ownable) contract hits, only
// paying that cost for the genuinely unusual ones.
const KNOWN_SELECTORS = new Set([
  "0x06fdde03", // name()
  "0x95d89b41", // symbol()
  "0x313ce567", // decimals()
  "0x18160ddd", // totalSupply()
  "0x70a08231", // balanceOf(address)
  "0xa9059cbb", // transfer(address,uint256)
  "0x23b872dd", // transferFrom(address,address,uint256)
  "0x095ea7b3", // approve(address,uint256)
  "0xdd62ed3e", // allowance(address,address)
  "0x8da5cb5b", // owner()
  "0x715018a6", // renounceOwnership()
  "0xf2fde38b", // transferOwnership(address)
]);

// Looks up whether ANY function signature has ever been registered anywhere
// matching this selector — not which one, just whether it's known to exist
// at all. Scam-token generators are heavily templated and reuse the same
// handful of function names constantly, so even most scams score low here;
// several selectors nobody has ever seen means genuinely bespoke,
// undocumented code — exactly where a custom balance-manipulation backdoor
// (confirmed live on catnip/NIP: balance dropped 99.97% with zero Transfer
// events — see realTrading.js's balance-vanished detection) would hide.
async function isKnownSelector(selector) {
  if (KNOWN_SELECTORS.has(selector)) return true;
  try {
    const res = await fetch(`https://www.4byte.directory/api/v1/signatures/?hex_signature=${selector}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null; // lookup failed — don't count against the token either way
    const body = await res.json();
    return (body.results || []).length > 0;
  } catch {
    return null; // best-effort — a network hiccup shouldn't penalize the token
  }
}

// Bytecode is immutable and a proxy's implementation slot essentially never
// changes inside the ~60-minute window a token gets evaluated in — the
// recheck queue re-evaluates a not-yet-passing token every ~2 minutes for up
// to an hour, and without caching that means re-running ~20 4byte.directory
// lookups per cycle for the exact same contract. Cached per token address for
// the life of the process instead.
const analysisCache = new Map();

export async function analyzeContractBytecode(chain, tokenAddress) {
  const cacheKey = `${chain.key}:${tokenAddress.toLowerCase()}`;
  if (analysisCache.has(cacheKey)) return analysisCache.get(cacheKey);

  const promise = (async () => {
    const provider = getProvider(chain);
    const [bytecode, implSlot] = await Promise.all([
      provider.getCode(tokenAddress),
      provider.getStorage(tokenAddress, EIP1967_IMPLEMENTATION_SLOT).catch(() => null),
    ]);
    const isProxy = Boolean(implSlot) && !/^0x0*$/.test(implSlot);

    const selectors = extractSelectors(bytecode);
    let unknownSelectorCount = 0;
    for (const selector of selectors) {
      const known = await isKnownSelector(selector);
      if (known === false) unknownSelectorCount++;
    }

    return { isProxy, unknownSelectorCount, totalSelectorCount: selectors.length };
  })().catch((err) => {
    analysisCache.delete(cacheKey); // don't cache a failure — worth retrying next cycle
    throw err;
  });

  analysisCache.set(cacheKey, promise);
  return promise;
}

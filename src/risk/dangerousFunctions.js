import { id as keccakId } from "ethers";
import { getProvider } from "../wallet.js";
import { extractSelectors } from "./selectorExtraction.js";

// A different question from bytecodeAnalysis.js's "how many functions here
// are unrecognized" (too noisy — legit custom tokens have plenty of benign
// unusual functions, confirmed live: DRIP, a legitimate token, scored
// similarly to confirmed scams because both share a common public
// generator template). This asks a narrower, higher-confidence question
// instead: does this contract expose a SPECIFIC, known-dangerous
// capability, regardless of whether it's active right now.
//
// Motivated by a real, repeating pattern: PONGO, 狗屎运, and DIH (three real
// trades, all on Robinhood Chain, which GoPlus doesn't cover at all) each
// passed every pre-buy check — including a real simulated sell — and were
// genuinely sellable at that moment, then had their balance vanish later
// with no corresponding sell from us. That's the signature of a contract
// the owner can drain at will, on their own schedule, independent of
// anything a point-in-time sell simulation can observe. No behavioral
// check (ours or anyone's) can catch a trap that isn't armed yet at check
// time — the only way to see it coming is to check whether the capability
// exists in the code at all.

// Direct arbitrary-balance manipulation — lets someone other than the
// holder move or destroy their tokens without that holder's involvement.
// No legitimate ERC20 needs any of these (note: burnFrom is deliberately
// excluded — that one's a standard, legitimate OpenZeppelin function
// gated by the token owner's own allowance, not a backdoor). Presence
// alone is treated as a fatal signal — there's no ordinary reason for a
// token contract to need this.
const TIER1_CONFISCATION_SELECTORS = {
  "0x33bebb77": "forceTransfer(address,address,uint256)",
  "0xda72c1e8": "adminTransfer(address,address,uint256)",
  "0x47298f82": "confiscate(address,uint256)",
  "0x5205f92f": "confiscateTokens(address,uint256)",
  "0xeb9253c0": "seize(address,uint256)",
  "0x88b9e10e": "seizeTokens(address,uint256)",
  "0x033bb4c1": "wipeBalance(address)",
  "0x32ba65aa": "clearBalance(address)",
  "0x06dd0419": "adminBurn(address,uint256)",
  "0x2850a0bd": "destroyBalance(address)",
  "0xe30443bc": "setBalance(address,uint256)",
  "0xe4ad9a18": "takeTokens(address,uint256)",
  "0xb8dbf876": "transferFromOwner(address,address,uint256)",
};

// Tier 2a — the subset of "switch" capability that can specifically stop US
// getting our money back out: an owner-controlled blacklist (blocks a named
// holder's sell outright) or an unbounded sell-fee/tax rewrite (lets the
// sale succeed but keeps ~all of the proceeds). Split out of the softer
// tier-2 list below and made enforceable because the soft framing turned out
// to be wrong for this population.
//
// Confirmed live: HOOPLA (0x6713fdEe…, Robinhood Chain, called 2026-08-13).
// It passed EVERY behavioural check at call time — probeSellability 0/8
// holders blocked, probeRoundTripTax a real simulated buy→sell losing only
// 0.6%, no tier-1 confiscation function, only 2 unknown selectors of 58 —
// while its bytecode exposed blacklistAccount + updateSellFees the whole
// time. Exactly the PONGO/狗屎运/DIH pattern in the header comment: the trap
// simply wasn't armed yet when we looked.
//
// The old "some benign tokens use a temporary blacklist" caveat does not
// hold here — measured across the last 40 called tokens, blacklist/fee-rewrite
// capability appeared in exactly 1 (3%), and that one was the honeypot. The
// cost of treating it as fatal is ~1 call in 40; the cost of not doing so is
// an unsellable position.
// Built by hashing signature strings at load time rather than hardcoding
// hex, because a fixed hex list is precisely how HOOPLA got through: the
// list had setBlacklist/addToBlacklist/blacklistWallet but not
// blacklistAccount, so a single naming variant walked straight past it.
// Pinning specific hashes only ever catches the variants someone already
// thought to write down. Generating name x parameter-shape combinations
// covers the naming space these contracts actually draw from, so the next
// token using setBlackList/banAccount/updateSellFee is caught by the same
// rule that caught this one.
const sel = (sig) => keccakId(sig).slice(0, 10);

// Owner can bar a specific address from transferring — i.e. decide that WE
// specifically cannot sell, at a time of their choosing.
const BLACKLIST_NAMES = [
  "blacklist", "blackList", "_blacklist", "setBlacklist", "setBlackList",
  "addBlacklist", "addToBlacklist", "addBlackList", "updateBlacklist",
  "blacklistAccount", "blacklistAddress", "blacklistWallet", "blacklistUser",
  "setBlacklisted", "setIsBlacklisted", "setBlacklistStatus",
  "blocklist", "setBlocklist", "addToBlocklist", "setBlocked",
  "denylist", "setDenylist", "addToDenylist",
  "ban", "banAccount", "banAddress", "banWallet", "setBan", "setBanned",
  "setBot", "setBots", "addBot", "addBots", "markBot", "setBotAddress",
  "setSniper", "setSnipers", "setExcludedFromTrading", "setCanTrade",
  "freezeAccount", "setFrozen", "freeze", "lockAccount", "setLocked",
  "restrict", "setRestricted",
];
const BLACKLIST_SHAPES = [
  "(address)", "(address,bool)", "(address[],bool)", "(address[])",
  "(address,uint256)", "(address,address)",
];

// Owner can raise the sell fee after launch — the sale succeeds but returns
// nothing, which is the same outcome as being blocked.
const FEE_NAMES = [
  "setFee", "setFees", "updateFee", "updateFees", "setTax", "setTaxes",
  "updateTax", "updateTaxes", "setSellTax", "setBuyTax", "setSellFee",
  "setBuyFee", "updateSellFee", "updateBuyFee", "updateSellFees",
  "updateBuyFees", "setTaxFee", "setTaxFeePercent", "setFeePercent",
  "setSellFeePercent", "setBuyFeePercent", "setTaxRate", "updateTaxRate",
  "setTransferTax", "setTotalFees", "updateFeeSettings", "setFeeRate",
  "changeFee", "changeFees", "changeTax", "setEarlySellTax",
];
const FEE_SHAPES = [
  "(uint256)", "(uint256,uint256)", "(uint256,uint256,uint256)",
  "(uint256,uint256,uint256,uint256)", "(uint256,uint256,uint256,uint256,uint256)",
  "(bool)", "(uint8)", "(uint16)", "(uint256,bool)",
];

// No-argument mutators that arm an existing tax/limit mechanism.
const ARMING_NAMES = [
  "enableEarlySellTax", "enableFees", "enableTax", "activateFees",
  "enableBlacklist", "enableRestrictions",
];

function buildSelectorMap(names, shapes) {
  const out = {};
  for (const n of names) for (const s of shapes) out[sel(n + s)] = n + s;
  return out;
}

const TIER2_SELL_BLOCKING_SELECTORS = {
  ...buildSelectorMap(BLACKLIST_NAMES, BLACKLIST_SHAPES),
  ...buildSelectorMap(FEE_NAMES, FEE_SHAPES),
  ...buildSelectorMap(ARMING_NAMES, ["()"]),
  // Odd shapes that don't fit the name x shape grid above.
  "0x9c0db5f3": "setBots(address[],bool)",
};

// Tier 2b — genuinely soft switches. A launch-time trading/swap toggle is
// common on legitimate tokens fending off snipers, and read-only getters
// (isBlacklisted) prove nothing on their own. Surfaced as a flag alongside
// the numeric score, same as the social signals in riskScore.js — never
// fatal.
const TIER2_SWITCH_SELECTORS = {
  "0x537df3b6": "removeFromBlacklist(address)",
  "0xfe575a87": "isBlacklisted(address)",
  "0xc2e5ec04": "setTradingEnabled(bool)",
  "0x8a8c523c": "enableTrading()",
  "0x1031e36e": "pauseTrading()",
  "0xe01af92c": "setSwapEnabled(bool)",
};

// EIP-1167 minimal proxy ("clone") — a fixed 45-byte template (10-byte
// prefix + 20-byte implementation address + 15-byte suffix) that cheap
// factories commonly deploy instead of full contract code. Confirmed live:
// 狗屎运 (one of the three balance_vanished honeypots this check exists
// for) is deployed exactly this way — reading its own bytecode directly
// found zero selectors at all, not because it has no logic, but because
// the real logic lives in a separate, shared implementation contract this
// proxy delegates every call to. Skipping this resolution step doesn't
// just miss the dangerous-function check for clone-deployed tokens, it
// falsely reports "clean" for having checked nothing.
const CLONE_PREFIX = "363d3d373d3d3d363d73";
const CLONE_SUFFIX = "5af43d82803e903d91602b57fd5bf3";

function resolveCloneTarget(bytecodeHex) {
  const hex = bytecodeHex.slice(2).toLowerCase();
  if (hex.length !== 90 || !hex.startsWith(CLONE_PREFIX) || !hex.endsWith(CLONE_SUFFIX)) return null;
  return "0x" + hex.slice(20, 60);
}

const cache = new Map();

// Returns { confiscationFunctions, sellBlockingFunctions, switchFunctions } —
// arrays of matched human-readable signatures, empty when none found.
// Never throws; a lookup failure just means "nothing detected", the same
// fail-open posture as every other self-hosted check in this file.
export async function detectDangerousFunctions(chain, tokenAddress) {
  const cacheKey = `${chain.key}:${tokenAddress.toLowerCase()}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);

  const promise = (async () => {
    const provider = getProvider(chain);
    // A transient RPC hiccup shouldn't silently look identical to "checked,
    // nothing found" — that's the one failure mode this check can't afford,
    // since the whole point is catching a capability a behavioral check
    // would miss. A couple of retries costs nothing against how rarely
    // this runs (once per token, cached after).
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        let bytecode = await provider.getCode(tokenAddress);
        const cloneTarget = resolveCloneTarget(bytecode);
        if (cloneTarget) bytecode = await provider.getCode(cloneTarget);
        const selectors = extractSelectors(bytecode);
        const confiscationFunctions = selectors
          .filter((s) => TIER1_CONFISCATION_SELECTORS[s])
          .map((s) => TIER1_CONFISCATION_SELECTORS[s]);
        const sellBlockingFunctions = selectors
          .filter((s) => TIER2_SELL_BLOCKING_SELECTORS[s])
          .map((s) => TIER2_SELL_BLOCKING_SELECTORS[s]);
        const switchFunctions = selectors.filter((s) => TIER2_SWITCH_SELECTORS[s]).map((s) => TIER2_SWITCH_SELECTORS[s]);
        return { confiscationFunctions, sellBlockingFunctions, switchFunctions };
      } catch (err) {
        if (attempt === 2) {
          console.error(`[dangerousFunctions] check failed for ${tokenAddress} after retries:`, err.message);
          return { confiscationFunctions: [], sellBlockingFunctions: [], switchFunctions: [] };
        }
        await new Promise((res) => setTimeout(res, 1000 * (attempt + 1)));
      }
    }
  })();

  cache.set(cacheKey, promise);
  return promise;
}

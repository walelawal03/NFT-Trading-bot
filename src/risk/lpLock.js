import { Contract, isAddress } from "ethers";
import { getProvider } from "../wallet.js";

// A Uniswap V2 pair contract IS the LP token (standard ERC20) — no GoPlus
// coverage needed. Validated against 257 real historical Robinhood Chain
// pairs (see scripts/backtestLpLock.js): locked-at-launch tokens rugged
// 70.4% of the time vs 88.2% unlocked — real signal, not a safety guarantee.
const DEAD_ADDRESS = "0x000000000000000000000000000000000000dEaD";
const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const LOCKED_FRACTION_THRESHOLD = 0.5;

const LP_TOKEN_ABI = [
  "function totalSupply() view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
];

// A failure here is not cost-free, despite returning null: applyFilter treats
// "LP lock status unknown" as a rejection (deliberately — see filter.js), so
// every transient RPC blip silently costs a call. Measured on 2026-08-13:
// 112 failures across 42 tokens, of which 34 were plain request timeouts —
// tokens rejected for a network hiccup, not for anything about the token.
//
// So retry the errors that can succeed on a second attempt, and don't retry
// the ones that can't. "missing revert data" (73 of those 112) means the
// address doesn't implement the LP-token ABI at all — a real, immediate
// answer that retrying only slows down.
const TRANSIENT_ERROR = /timeout|ETIMEDOUT|ENOTFOUND|ECONNRESET|ECONNREFUSED|EAI_AGAIN|socket hang up|SERVER_ERROR|502|503|504|rate.?limit|429/i;

// Checks current LP-token lock status for a pair. Returns null (not "false")
// on any failure — callers should treat null as "unknown," not "unlocked,"
// since a transient RPC error shouldn't masquerade as a real risk signal.
export async function checkLpLock(chain, pairAddress) {
  if (!pairAddress) return null;
  // DexScreener returns a 32-byte pool ID, not a contract address, for
  // Uniswap V4 pairs (dexId "uniswap", labels ["v4"]) — seen live on
  // Robinhood Chain. V4 keeps every pool in one singleton PoolManager and
  // issues no per-pair ERC20, so there is no LP token to weigh here at all.
  // Passing the ID to `new Contract()` made ethers fall back to treating it
  // as an ENS name and fail with a misleading "network does not support ENS",
  // burning three RPC attempts per check on a call that could never succeed.
  if (!isAddress(pairAddress)) {
    console.error(`[lpLock] ${pairAddress} is not a contract address (likely a Uniswap V4 pool ID) — no LP token to check`);
    return null;
  }
  const ATTEMPTS = 3;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    try {
      const provider = getProvider(chain);
      const pair = new Contract(pairAddress, LP_TOKEN_ABI, provider);
      const [total, dead, zero] = await Promise.all([
        pair.totalSupply(),
        pair.balanceOf(DEAD_ADDRESS),
        pair.balanceOf(ZERO_ADDRESS),
      ]);
      if (total === 0n) return null;
      const lockedFraction = Number(((dead + zero) * 10000n) / total) / 10000;
      return { lockedFraction, isLocked: lockedFraction >= LOCKED_FRACTION_THRESHOLD };
    } catch (err) {
      const retryable = TRANSIENT_ERROR.test(err.message || "");
      if (!retryable || attempt === ATTEMPTS - 1) {
        console.error(
          `[lpLock] check failed for ${pairAddress}${retryable ? ` after ${ATTEMPTS} attempts` : ""}:`,
          err.message
        );
        return null;
      }
      await new Promise((res) => setTimeout(res, 800 * (attempt + 1)));
    }
  }
  return null;
}

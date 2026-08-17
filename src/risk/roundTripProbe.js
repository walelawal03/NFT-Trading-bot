import { Contract, Interface, parseEther } from "ethers";
import { getProvider } from "../wallet.js";
import { roundTripProbeAbi, roundTripProbeBytecode } from "./roundTripProbeArtifact.js";

// Catches what probeSellability (sellability.js) structurally can't: a
// honeypot that taxes/burns almost the entire sale instead of reverting it.
// A plain staticCall of transfer() only tells us whether the call reverted —
// it can't see how many tokens actually landed, so a 100%-sell-tax token
// (transfer succeeds, value just evaporates) sails straight through it.
// Confirmed real motivation: MNEMO/Robinhood Chain — a third-party bot's own
// buy+sell simulation printed "Tax: S 100%" and flagged it a honeypot; our
// existing pre-buy checks had no equivalent for this chain (GoPlus doesn't
// cover Robinhood Chain at all, so there's no sell_tax field to read either).
//
// Technique: plant RoundTripProbe's bytecode + a scratch native-currency
// balance at a throwaway address via eth_call's state-override param, then
// call its probe() function, which really executes buy-then-sell through the
// live router in one atomic call. Every tax/fee/blacklist mechanism the
// token's own code implements applies exactly as it would for a real trade —
// there's no need to guess the token's storage layout (unlike faking a
// balance/allowance directly), because the tokens the probe sells are ones
// it just genuinely received from a real simulated buy.
//
// Only supports V2-style routers for now (swapExactETHForTokens... /
// swapExactTokensForETH...) — new-launch tokens overwhelmingly start there.
// V3-only pairs aren't probed; caller should treat honeypot: null as
// "unknown", never as "safe", same convention as probeSellability.

const SCRATCH_ADDRESS = "0x0000000000000000000000000000000000000f00";
// Round-trip loss floor to call it a honeypot. Deliberately well above
// normal LP fee (~0.25-0.3%) plus a modest allowance for price impact on
// thin liquidity — legitimate tokens with a marketing/reflection tax rarely
// exceed 10-15% each way (~25% round trip); a honeypot's sell-side tax is
// typically total or near-total.
const HONEYPOT_ROUND_TRIP_LOSS = 0.6;
// Small enough that price impact on a thin-but-real pool doesn't itself
// manufacture a false positive, large enough that rounding/dust doesn't
// swamp the result.
const PROBE_AMOUNT_NATIVE = "0.003";

// Delivery floor, as a fraction of what the router's own getAmountsOut quotes
// for the same trade. Below this, the token took the difference during or
// immediately after delivery.
//
// Deliberately generous, because a legitimate fee-on-transfer token really
// does land below its quote — getAmountsOut prices the pool, not the token's
// internal transfer fee, so a 10% buy tax lands at ~90% of quote and even an
// aggressive one rarely goes past ~25%. Landing under 40% is not a tax, it is
// confiscation.
//
// This is the pre-trade twin of the post-buy minOut check in swapExecutor,
// aimed at the pattern that drained this wallet: usocks and BOTTOM each
// reported exactly 1e12 from balanceOf regardless of how much the router
// transferred in (46.3e12 and 64.3e12 respectively). The probe reads its
// position with the same balanceOf the scam lies to, so comparing that number
// against an independent quote is what exposes the gap.
const MIN_DELIVERED_FRACTION_OF_QUOTE = 0.4;

const ROUTER_QUOTE_ABI = ["function getAmountsOut(uint256 amountIn, address[] path) view returns (uint256[])"];

// Returns:
//   { tested: true, honeypot: true|false, roundTripLossPct, nativeIn, nativeOut }
//   { tested: false, honeypot: null, reason }   — not enough support / lookup failed
// honeypot: null must be treated as "unknown", never as "safe".
// What the pool alone says this buy should yield, with no involvement from the
// token's own accounting. Returns null when unavailable — a missing quote must
// leave the delivery check unarmed rather than manufacture a verdict from a
// number we don't have.
async function quoteExpectedOut(chain, tokenAddress, amountIn) {
  try {
    const router = new Contract(chain.routerAddress, ROUTER_QUOTE_ABI, getProvider(chain));
    const amounts = await router.getAmountsOut(amountIn, [chain.wrappedNative, tokenAddress]);
    return amounts[amounts.length - 1];
  } catch {
    return null;
  }
}

export async function probeRoundTripTax(chain, tokenAddress) {
  if (!chain.routerAddress) return { tested: false, honeypot: null, reason: "No V2 router configured for this chain" };

  try {
    const provider = getProvider(chain);
    const iface = new Interface(roundTripProbeAbi);
    const amountIn = parseEther(PROBE_AMOUNT_NATIVE);

    const data = iface.encodeFunctionData("probe", [chain.routerAddress, chain.wrappedNative, tokenAddress, amountIn]);

    const result = await provider.send("eth_call", [
      { to: SCRATCH_ADDRESS, data },
      "latest",
      {
        [SCRATCH_ADDRESS]: {
          code: roundTripProbeBytecode,
          balance: "0x" + amountIn.toString(16),
        },
      },
    ]);

    const [buyOk, tokensReceived, sellOk, nativeReceived] = iface.decodeFunctionResult("probe", result);

    if (!buyOk) {
      return { tested: false, honeypot: null, reason: "Simulated buy leg reverted (unrelated to sell-side honeypot behavior)" };
    }
    if (tokensReceived === 0n) {
      return { tested: true, honeypot: null, reason: "Simulated buy leg returned zero tokens (no liquidity path?)" };
    }
    // Checked before the sell leg's result, because it describes a different
    // crime and the caller should hear the accurate one. The sell can succeed
    // perfectly well here — selling dust at a fair price still "works", which
    // is exactly how this pattern survives a round-trip check.
    const quoted = await quoteExpectedOut(chain, tokenAddress, amountIn);
    // Reported on every tested outcome, not just the blocking one, so the log
    // shows how much headroom a passing token actually had. Calibrating a
    // threshold is impossible if the number is only recorded when it trips.
    const deliveredFraction = quoted != null && quoted > 0n ? Number((tokensReceived * 10000n) / quoted) / 10000 : null;
    if (deliveredFraction != null && deliveredFraction < MIN_DELIVERED_FRACTION_OF_QUOTE) {
      return {
        tested: true,
        honeypot: true,
        clawback: true,
        deliveredFraction,
        reason:
          `Token delivered only ${(deliveredFraction * 100).toFixed(1)}% of the ${quoted} tokens the router quoted ` +
          `(wallet holds ${tokensReceived}) — the balance is stripped on receipt, so most of any buy is simply taken`,
      };
    }

    if (!sellOk) {
      // Real tokens were acquired via a real simulated buy, and the sell
      // leg failed outright — about as unambiguous a honeypot signal as
      // exists, distinct from the percentage-based tax check below.
      return { tested: true, honeypot: true, deliveredFraction, reason: "Sell leg reverted outright after a successful buy" };
    }

    const nativeOut = Number(nativeReceived) / 1e18;
    const nativeIn = Number(amountIn) / 1e18;
    const roundTripLossPct = 1 - nativeOut / nativeIn;

    return {
      tested: true,
      honeypot: roundTripLossPct >= HONEYPOT_ROUND_TRIP_LOSS,
      roundTripLossPct,
      deliveredFraction,
      nativeIn,
      nativeOut,
    };
  } catch (err) {
    // Only infra-level failures land here now (the contract itself no
    // longer lets either leg's revert propagate) — an RPC hiccup or a chain
    // whose node doesn't support state overrides, not honeypot evidence.
    //
    // retryable marks this as "the check never ran", as opposed to the
    // structural `tested: false` returns above ("this chain/pair can't be
    // probed at all"). Callers must be able to tell those apart: the first is
    // a temporary blindness worth waiting out before spending money, the
    // second is a permanent condition that would block the chain forever.
    return { tested: false, honeypot: null, retryable: true, reason: `Probe failed: ${err.message}` };
  }
}

import { Interface } from "ethers";
import { getProvider } from "../wallet.js";
import { nftRoundTripProbeAbi, nftRoundTripProbeBytecode } from "./nftRoundTripProbeArtifact.js";

// Can we mint it, and can we get back out?
//
// Stage B of the underwriter. Stage A (nftDangerousFunctions.js) reads the
// bytecode for known seizure and lock selectors, which catches the crude
// version of this. It cannot catch a transfer that reverts for a reason only
// visible at runtime: a transfer validator with an empty allowlist, a paused
// flag, a soulbound branch behind a storage bool, an operator filter nobody
// has registered with yet. None of those are a selector — they are state.
//
// So this mints one for real and moves it for real, in a single atomic
// eth_call against live chain state, with the probe bytecode and a scratch
// balance planted by state override. Zero gas, no key, no funds, no
// transaction. Nothing is broadcast and nothing persists — the override is
// discarded when the call returns.
//
// Neither reference bot has anything like this. osnm-z signs opaque calldata
// it cannot verify; nft-public-mint has no simulation at all. Both would
// happily mint into a collection whose tokens can never be sold, which is not
// a smaller loss than a rug — it is the same loss, arrived at politely.

const PROBE_ADDRESS = "0x0000000000000000000000000000000000000f00";

// The operator is SEAPORT'S OWN ADDRESS, not a scratch one, and the identity
// is the entire point.
//
// Modern drops increasingly sit behind a transfer validator — Limit Break's
// CreatorTokenTransferValidator at 0xA000027A... is the common one, found on
// live Robinhood collections — which permits transfers only from operators on
// an allowlist. Against a random scratch operator such a collection always
// reports blocked, which is true and useless: it answers "can this arbitrary
// address move it", when the question is "can the address that will actually
// move it move it".
//
// Planting the probe's code here via state override makes msg.sender inside
// the transfer equal to Seaport, so the validator's allowlist is consulted
// for the operator that a real fill would use. Overwriting Seaport's own code
// for the duration of the call is fine and deliberate: we are not testing
// Seaport's logic, only borrowing its identity.
//
// Kept in step with nftExecutor.js's SEAPORT_ADDRESS, which is what
// listNftForSale approves (conduitKey is ZeroHash there, so Seaport itself
// performs the transfer rather than a conduit). If that ever changes to a
// conduit, this must change with it or the probe stops answering the same
// question the sell path asks.
const OPERATOR_ADDRESS = "0x0000000000000068F116a894984e2DB1123eB395";
// Where the token is sent. Must have no code, so safeTransferFrom's receiver
// check is a no-op and cannot itself manufacture a failure.
const SINK_ADDRESS = "0x0000000000000000000000000000000000000f02";

// Headroom over the mint price for whatever the drop charges beyond it. The
// probe pays no gas, so this only has to cover value, and overshooting costs
// nothing — the balance is invented for the duration of one call.
const VALUE_HEADROOM = 2n;

const iface = new Interface(nftRoundTripProbeAbi);

/**
 * @returns {Promise<{
 *   checked: boolean,
 *   exitable: boolean|null,
 *   verdict: string,
 *   reason: string,
 *   tokenId: string|null,
 *   detail: object|null,
 * }>}
 *
 * `exitable: null` means UNKNOWN and must never be read as safe — the same
 * convention as honeypot: null in sellability.js and checked: false in
 * nftDangerousFunctions.js. A drop we could not probe is a drop we know
 * nothing about, not a drop that passed.
 */
export async function probeNftRoundTrip(chain, { mintCall, contractAddress, budgetMs = 12000, atTimestamp = null } = {}) {
  const unknown = (reason) => ({
    checked: false,
    exitable: null,
    verdict: "UNKNOWN",
    reason,
    tokenId: null,
    detail: null,
  });

  if (!mintCall?.to || !mintCall?.data) return unknown("No mint call to simulate");
  if (!contractAddress) return unknown("No collection address");

  const value = BigInt(mintCall.value ?? 0n);
  const balance = value * VALUE_HEADROOM + 1n;

  const data = iface.encodeFunctionData("probe", [
    mintCall.to,
    mintCall.data,
    value,
    contractAddress,
    OPERATOR_ADDRESS,
    SINK_ADDRESS,
  ]);

  let raw;
  try {
    const provider = getProvider(chain);
    // One budget for the whole thing, not per attempt. A per-call bound leaves
    // the provider's own retry backoff unbounded, so a 12s ceiling silently
    // becomes a minute against a fast-failing endpoint — the trap already
    // fixed in nftDangerousFunctions.js.
    const params = [
      // `from` is the probe itself, which is the point: inside the mint,
      // msg.sender and tx.origin are then the same address, so the
      // `require(msg.sender == tx.origin)` anti-bot check that a good number
      // of drops carry passes instead of failing the probe for a reason
      // that has nothing to do with exitability.
      { from: PROBE_ADDRESS, to: PROBE_ADDRESS, data },
      "latest",
      {
        [PROBE_ADDRESS]: { code: nftRoundTripProbeBytecode, balance: "0x" + balance.toString(16) },
        [OPERATOR_ADDRESS]: { code: nftRoundTripProbeBytecode },
      },
    ];
    // Simulating past a drop's start time is what lets this answer for a mint
    // that has not opened — otherwise every scheduled drop reports
    // MINT_FAILED, which is exactly the case where knowing early is worth
    // most. A geth extension, verified honoured on both Robinhood endpoints
    // by behaviour rather than by the absence of an error.
    if (atTimestamp != null) params.push({ time: "0x" + BigInt(atTimestamp).toString(16) });

    raw = await Promise.race([
      provider.send("eth_call", params),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`probe budget ${budgetMs}ms exceeded`)), budgetMs)),
    ]);
  } catch (err) {
    // A node that refuses state overrides is the common case on cheap
    // endpoints, and it is not a finding about the collection.
    const msg = err?.error?.message || err?.info?.error?.message || err?.shortMessage || err.message;
    return unknown(`Simulation unavailable: ${msg}`);
  }

  let r;
  try {
    [r] = iface.decodeFunctionResult("probe", raw);
  } catch {
    return unknown("Probe returned something undecodable — the node may not support state overrides");
  }

  const detail = {
    mintOk: r.mintOk,
    minted: r.minted.toString(),
    tokenIdKnown: r.tokenIdKnown,
    approvalOk: r.approvalOk,
    operatorTransferOk: r.operatorTransferOk,
    // False here means "not tested" whenever the operator path already
    // succeeded, because the token had moved and there was nothing left to
    // transfer. Only meaningful when operatorTransferOk is false.
    ownerTransferOk: r.ownerTransferOk,
  };
  const tokenId = r.tokenIdKnown ? r.tokenId.toString() : null;

  // Ordered by what each outcome actually means, most conclusive first.

  if (!r.mintOk) {
    // Not a verdict about exiting. The mint leg failing is its own thing —
    // sold out, not started, allowlist-only, or an anti-contract guard we did
    // not defeat — and reporting it as "cannot exit" would condemn drops that
    // are merely closed.
    return { checked: false, exitable: null, verdict: "MINT_FAILED", reason: "The simulated mint reverted, so the exit was never tested", tokenId: null, detail };
  }

  if (r.minted === 0n) {
    return { checked: true, exitable: null, verdict: "NO_DELIVERY", reason: "The mint call succeeded but delivered no token", tokenId: null, detail };
  }

  if (!r.tokenIdKnown) {
    // Held something we cannot name, so the exit could not be attempted.
    // Unknown, not passing.
    return { checked: false, exitable: null, verdict: "UNKNOWN", reason: "Minted, but the token id could not be determined (no receiver hook, not enumerable)", tokenId: null, detail };
  }

  if (r.operatorTransferOk) {
    return { checked: true, exitable: true, verdict: "EXITABLE", reason: "Minted, approved an operator, and the operator moved it — the sale path works", tokenId, detail };
  }

  if (!r.approvalOk) {
    return { checked: true, exitable: false, verdict: "APPROVAL_BLOCKED", reason: "setApprovalForAll reverted — no marketplace can ever be approved to sell this", tokenId, detail };
  }

  if (r.ownerTransferOk) {
    // The distinction the ordering exists to draw: the owner can move it, the
    // approved operator cannot. That is a transfer validator or operator
    // allowlist, not a soulbound token. Often it is simply unconfigured and
    // will start working — but until it does, it cannot be sold on a
    // marketplace, so it is not a pass.
    return { checked: true, exitable: false, verdict: "OPERATOR_BLOCKED", reason: "The owner can transfer it but an approved operator cannot — an operator allowlist or transfer validator blocks marketplace sales", tokenId, detail };
  }

  return { checked: true, exitable: false, verdict: "SOULBOUND", reason: "Minted, and neither the owner nor an approved operator can move it — the position cannot be exited", tokenId, detail };
}

/**
 * Points this verdict costs a collection's score.
 *
 * Capped at 40 and returned as a deduction rather than a score, so it drops
 * into the existing weighting the same way assessNftContractRisk does. A
 * verdict we could not reach costs a little — unknown costs points, it does
 * not earn them (see NO_DATA_FACTOR in the notes; this module inverts it).
 */
export function assessNftRoundTrip(result) {
  switch (result?.verdict) {
    case "EXITABLE":
      return { deduction: 0, label: "Exit verified on-chain" };
    // Nothing can move. This is the whole reason the module exists and it is
    // the maximum single deduction available here.
    case "SOULBOUND":
      return { deduction: 40, label: "Cannot be transferred — unexitable" };
    case "APPROVAL_BLOCKED":
      return { deduction: 40, label: "No marketplace can be approved" };
    // Real, blocking, but frequently a validator that is simply not set up
    // yet rather than malice — heavy, not fatal.
    case "OPERATOR_BLOCKED":
      return { deduction: 30, label: "Marketplace sales blocked by an operator filter" };
    case "NO_DELIVERY":
      return { deduction: 25, label: "Mint delivered nothing" };
    case "MINT_FAILED":
      return { deduction: 0, label: "Mint closed or restricted — exit untested" };
    default:
      return { deduction: 8, label: "Exit could not be verified" };
  }
}

export const PROBE_ADDRESSES = { PROBE_ADDRESS, OPERATOR_ADDRESS, SINK_ADDRESS };

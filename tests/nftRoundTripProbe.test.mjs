// Offline exercise of nftRoundTripProbe.js. No RPC: a stub provider returns
// an ABI-encoded probe Result, so every verdict branch can be driven
// deterministically — including the ones a live chain would almost never
// hand us on demand (soulbound, approval blocked, undecodable response).
//
// Run: node --experimental-test-module-mocks tests/nftRoundTripProbe.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import { Interface } from "ethers";
import { nftRoundTripProbeAbi } from "../src/risk/nftRoundTripProbeArtifact.js";

// What the stubbed eth_call will answer with, per case. Set before each call.
let RESPONSE = null;
let LAST_REQUEST = null;

mock.module(new URL("../src/wallet.js", import.meta.url).href, {
  namedExports: {
    getProvider: () => ({
      send: async (method, params) => {
        LAST_REQUEST = { method, params };
        if (typeof RESPONSE === "function") return RESPONSE();
        return RESPONSE;
      },
    }),
    getWalletForChain: () => null,
    httpUrlFor: () => "http://stub",
  },
});

const { probeNftRoundTrip, assessNftRoundTrip, PROBE_ADDRESSES } = await import("../src/risk/nftRoundTripProbe.js");

const iface = new Interface(nftRoundTripProbeAbi);

// Encodes a probe Result exactly as the deployed contract would, so the test
// exercises the real decode path rather than a hand-made shape that happens
// to match what the code expects.
function encodeResult({
  mintOk = false,
  minted = 0n,
  tokenId = 0n,
  tokenIdKnown = false,
  approvalOk = false,
  operatorTransferOk = false,
  ownerTransferOk = false,
} = {}) {
  return iface.encodeFunctionResult("probe", [
    { mintOk, minted, tokenId, tokenIdKnown, approvalOk, operatorTransferOk, ownerTransferOk },
  ]);
}

const CHAIN = { key: "robinhood", label: "Robinhood Chain" };
const CALL = { to: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5", data: "0x161ac21f", value: 1000n };
const NFT = "0x819ca7ccc7da4b78441d2c0c51b89be034174917";

const run = (over) => probeNftRoundTrip(CHAIN, { mintCall: CALL, contractAddress: NFT, ...over });

test("a full round trip through an approved operator is EXITABLE", async () => {
  RESPONSE = encodeResult({ mintOk: true, minted: 1n, tokenId: 29n, tokenIdKnown: true, approvalOk: true, operatorTransferOk: true });
  const r = await run();
  assert.equal(r.verdict, "EXITABLE");
  assert.equal(r.exitable, true);
  assert.equal(r.checked, true);
  assert.equal(r.tokenId, "29");
});

test("nothing can move it — SOULBOUND, and that is the heaviest deduction", async () => {
  RESPONSE = encodeResult({ mintOk: true, minted: 1n, tokenId: 3n, tokenIdKnown: true, approvalOk: true, operatorTransferOk: false, ownerTransferOk: false });
  const r = await run();
  assert.equal(r.verdict, "SOULBOUND");
  assert.equal(r.exitable, false);
  assert.equal(assessNftRoundTrip(r).deduction, 40);
});

test("owner can move it but an operator cannot — OPERATOR_BLOCKED, not SOULBOUND", async () => {
  // The distinction the probe's whole call ordering exists to draw. Reading
  // this as soulbound would condemn a collection whose validator is merely
  // unconfigured; reading it as exitable would buy something unsellable.
  RESPONSE = encodeResult({ mintOk: true, minted: 1n, tokenId: 2041n, tokenIdKnown: true, approvalOk: true, operatorTransferOk: false, ownerTransferOk: true });
  const r = await run();
  assert.equal(r.verdict, "OPERATOR_BLOCKED");
  assert.equal(r.exitable, false);
  assert.equal(assessNftRoundTrip(r).deduction, 30);
});

test("approval itself reverting is APPROVAL_BLOCKED", async () => {
  RESPONSE = encodeResult({ mintOk: true, minted: 1n, tokenId: 5n, tokenIdKnown: true, approvalOk: false, ownerTransferOk: false });
  const r = await run();
  assert.equal(r.verdict, "APPROVAL_BLOCKED");
  assert.equal(r.exitable, false);
});

test("a failed mint leg is never reported as an exit failure", async () => {
  // Sold out, not started, or allowlist-only. Condemning these as unexitable
  // would reject drops that are merely closed.
  RESPONSE = encodeResult({ mintOk: false });
  const r = await run();
  assert.equal(r.verdict, "MINT_FAILED");
  assert.equal(r.exitable, null);
  assert.equal(r.checked, false);
  assert.equal(assessNftRoundTrip(r).deduction, 0);
});

test("a mint that succeeds but delivers nothing is its own finding", async () => {
  RESPONSE = encodeResult({ mintOk: true, minted: 0n });
  const r = await run();
  assert.equal(r.verdict, "NO_DELIVERY");
  assert.equal(r.exitable, null);
});

test("minted but unnameable token is UNKNOWN, never a pass", async () => {
  RESPONSE = encodeResult({ mintOk: true, minted: 1n, tokenIdKnown: false });
  const r = await run();
  assert.equal(r.verdict, "UNKNOWN");
  assert.equal(r.exitable, null);
  assert.equal(r.checked, false);
});

test("a node that refuses the override yields UNKNOWN, not a verdict", async () => {
  RESPONSE = () => {
    const e = new Error("the method eth_call does not exist/is not available");
    throw e;
  };
  const r = await run();
  assert.equal(r.exitable, null);
  assert.equal(r.verdict, "UNKNOWN");
  assert.match(r.reason, /Simulation unavailable/);
});

test("an undecodable response is UNKNOWN rather than a crash", async () => {
  RESPONSE = "0x1234";
  const r = await run();
  assert.equal(r.exitable, null);
  assert.equal(r.verdict, "UNKNOWN");
});

test("the budget is enforced end to end, not per attempt", async () => {
  // A provider that never settles must not hang the caller. Bounding each
  // attempt instead would leave retry backoff unbounded — the trap already
  // fixed in nftDangerousFunctions.js.
  RESPONSE = () => new Promise(() => {});
  const t0 = Date.now();
  const r = await run({ budgetMs: 250 });
  const elapsed = Date.now() - t0;
  assert.equal(r.exitable, null);
  assert.ok(elapsed < 2000, `waited ${elapsed}ms`);
  assert.match(r.reason, /budget/i);
});

test("missing inputs are refused before any network call", async () => {
  RESPONSE = () => {
    throw new Error("should not have been called");
  };
  for (const bad of [{ mintCall: null }, { mintCall: { to: null, data: "0x" } }, { contractAddress: null }]) {
    const r = await probeNftRoundTrip(CHAIN, { mintCall: CALL, contractAddress: NFT, ...bad });
    assert.equal(r.exitable, null);
    assert.equal(r.checked, false);
  }
});

test("the operator is Seaport, and from equals the probe address", async () => {
  // Two load-bearing details. `from == to == probe` makes msg.sender and
  // tx.origin match inside the mint, so an anti-bot require() passes. And the
  // operator must be the address that will really move the token, or a
  // transfer validator's allowlist is being consulted about the wrong party.
  RESPONSE = encodeResult({ mintOk: true, minted: 1n, tokenId: 1n, tokenIdKnown: true, approvalOk: true, operatorTransferOk: true });
  await run();
  const [callObj, block, overrides] = LAST_REQUEST.params;
  assert.equal(callObj.from, PROBE_ADDRESSES.PROBE_ADDRESS);
  assert.equal(callObj.to, PROBE_ADDRESSES.PROBE_ADDRESS);
  assert.equal(block, "latest");
  assert.equal(PROBE_ADDRESSES.OPERATOR_ADDRESS, "0x0000000000000068F116a894984e2DB1123eB395");
  // Both the probe and the operator must carry code, or the operator leg
  // tests nothing.
  assert.ok(overrides[PROBE_ADDRESSES.PROBE_ADDRESS].code.length > 100);
  assert.ok(overrides[PROBE_ADDRESSES.OPERATOR_ADDRESS].code.length > 100);
  // And the probe must be funded for the mint, or a paid drop reverts for
  // lack of value rather than for anything we are testing.
  assert.ok(BigInt(overrides[PROBE_ADDRESSES.PROBE_ADDRESS].balance) >= CALL.value);
});

test("unknown costs points instead of earning them", async () => {
  // NO_DATA_FACTOR awards 30% of a category's weight for learning nothing.
  // This module inverts that deliberately.
  assert.ok(assessNftRoundTrip({ verdict: "UNKNOWN" }).deduction > 0);
  assert.ok(assessNftRoundTrip(null).deduction > 0);
  assert.equal(assessNftRoundTrip({ verdict: "EXITABLE" }).deduction, 0);
});

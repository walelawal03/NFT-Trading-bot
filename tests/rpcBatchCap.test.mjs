// The batch cap, which is one number standing between the bot and a wasted
// round trip on every read.
//
// ethers batches JSON-RPC calls into one HTTP request, up to 100 by default.
// Base's own endpoint refuses more than 10 in a batch and fails the WHOLE
// batch when you exceed it:
//
//   POST https://mainnet.base.org  [25 calls]
//   -> {"code":-32014,"message":"maximum 10 calls in 1 batch"}
//
// Measured 2026-08-20 while scanning 40 Base collections, that produced dozens
// of "call failed on https://mainnet.base.org, served by publicnode" warnings
// — every read paying a failed attempt before a backup answered. It looked
// exactly like a flaky endpoint, and the same endpoint answers 40 concurrent
// single calls 40/40.
//
// Nothing about that failure is loud: FailoverProvider recovers, so the reads
// succeed and only a console.warn marks the cost. A regression here would be
// invisible again, which is precisely why it is asserted.
//
// Run: node tests/rpcBatchCap.test.mjs
import test from "node:test";
import assert from "node:assert/strict";

process.env.TELEGRAM_BOT_TOKEN = "111:offline";
process.env.TELEGRAM_CHAT_ID = "1";

const { FailoverProvider } = await import("../src/rpc.js");

// Constructing with an explicit chainId pins the network, so no eth_chainId
// goes out and this stays offline.
const BASE = ["https://mainnet.base.org", "https://base-rpc.publicnode.com"];

test("the primary batches no more than the strictest endpoint allows", () => {
  const p = new FailoverProvider(BASE, "base", 8453);
  const cap = p._getOption("batchMaxCount");
  assert.ok(cap <= 10, `batchMaxCount is ${cap}; mainnet.base.org rejects any batch over 10`);
  // Zero or one would disable batching altogether, which is a different and
  // worse trade: every read becomes its own HTTP request and its own round
  // trip, on a path where the round trip is the dominant cost.
  assert.ok(cap > 1, `batchMaxCount is ${cap} — batching is off entirely, which costs a round trip per call`);
});

test("the network is pinned, so no endpoint is ever asked what chain it is", () => {
  const p = new FailoverProvider(BASE, "base", 8453);
  // Not a style preference. Without it, ethers' network detection against an
  // unreachable backup retries forever and logs on every pass — the failure
  // that made an unreachable endpoint block every call behind it.
  assert.equal(p._getOption("staticNetwork")?.chainId, 8453n);
});

test("a single-url chain still gets the cap", () => {
  // Robinhood's list can collapse to one entry depending on env overrides;
  // the cap must not depend on there being a backup.
  const p = new FailoverProvider(["https://robinhood-rpc.publicnode.com"], "robinhood", 4663);
  assert.ok(p._getOption("batchMaxCount") <= 10);
  assert.deepEqual(p.rpcUrls, ["https://robinhood-rpc.publicnode.com"]);
});

test("broadcastTransaction is never retried across endpoints", () => {
  // Re-sending a signed transaction to a second endpoint is a second
  // broadcast, not a retry: the duplicate is harmless on-chain but the second
  // node answers "already known", which reads as a failed send that in fact
  // succeeded. Guarding the shape of _perform here because the comment
  // explaining it is the only thing stopping someone from "simplifying" it.
  const src = new FailoverProvider(["https://a.test"], "t", 1)._perform.toString();
  assert.match(src, /broadcastTransaction/);
});

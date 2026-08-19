// Offline exercise of mintScheduler.js — the one feature that has never
// actually fired in production, so its behaviour is asserted here rather than
// assumed. Executor and detector are stubbed, so the clock is the only real
// thing: arm a mint that opens in a moment and watch what the loop does.
//
// Run: node --experimental-test-module-mocks tests/mintScheduler.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Redirect the armed-mint store to a temp dir before anything imports
// dataDir.js, so persistence can be exercised without touching the real one.
const DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "mint-sched-"));
process.env.RAILWAY_VOLUME_MOUNT_PATH = DATA_DIR;
const storePath = path.join(DATA_DIR, "armedMints.json");

let prepareCalls = 0;
let broadcastCalls = 0;
let detectCalls = 0;
let prepareDelayMs = 0;
let prepareResult = null;

mock.module(new URL("../src/mint/nftMintExecutor.js", import.meta.url).href, {
  namedExports: {
    prepareSignedMints: async () => {
      prepareCalls++;
      if (prepareDelayMs) await new Promise((r) => setTimeout(r, prepareDelayMs));
      return prepareResult ?? { ok: true, signed: [{ ok: true, address: "0xabc", raw: "0xdead" }], call: { to: "0x1", data: "0x2", value: 0n } };
    },
    broadcastSigned: async () => {
      broadcastCalls++;
      return [{ ok: true, address: "0xabcdef0123", txHash: "0xfeed", sendMs: 12 }];
    },
  },
});

mock.module(new URL("../src/mint/nftMintDetect.js", import.meta.url).href, {
  namedExports: {
    detectNftMint: async () => {
      detectCalls++;
      return { standard: "seadrop", phase: { startsAt: new Date(startsAt), priceWei: 0n, maxPerWallet: 1 }, mintable: true, mintVia: { target: "0x1" } };
    },
  },
});

let startsAt = Date.now() + 3600_000;

const { armMint, disarmMint, listArmedMints, startMintScheduler } = await import("../src/mint/mintScheduler.js");

const CHAIN = { key: "robinhood", label: "Robinhood Chain" };
const ADDR = "0x819ca7ccc7da4b78441d2c0c51b89be034174917";

const detectFor = (ms) => ({
  standard: "seadrop",
  phase: { startsAt: new Date(ms), priceWei: 0n, maxPerWallet: 1 },
  mintable: false,
  mintVia: { target: "0x1" },
});

const reset = () => {
  prepareCalls = 0;
  broadcastCalls = 0;
  detectCalls = 0;
  prepareDelayMs = 0;
  prepareResult = null;
  for (const a of listArmedMints()) disarmMint(a.chainKey, a.contractAddress);
};

const arm = (opensInMs, over = {}) => {
  startsAt = Date.now() + opensInMs;
  return armMint({
    chain: CHAIN,
    contractAddress: ADDR,
    detect: detectFor(startsAt),
    quantity: 1,
    walletCount: 1,
    chatId: 1,
    ...over,
  });
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("a phase already open is refused rather than armed", () => {
  reset();
  const r = armMint({ chain: CHAIN, contractAddress: ADDR, detect: detectFor(Date.now() - 1000), quantity: 1, walletCount: 1, chatId: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already open/);
  assert.equal(listArmedMints().length, 0);
});

test("a drop with no scheduled phase is refused", () => {
  reset();
  const r = armMint({ chain: CHAIN, contractAddress: ADDR, detect: { standard: "direct", phase: { startsAt: null } }, quantity: 1, walletCount: 1, chatId: 1 });
  assert.equal(r.ok, false);
});

test("it prepares exactly once, then fires exactly once, at the open", async () => {
  reset();
  // Opens shortly, well inside the 90s prepare lead, so the loop should
  // prepare on its first tick and fire when the clock passes the open.
  arm(2500);
  const stop = startMintScheduler({ notify: async () => {} });
  try {
    await wait(4500);
  } finally {
    stop();
  }
  // The bug this pins down: with no in-flight guard, a prepare slower than
  // one tick is started again on every subsequent tick, signing several sets
  // of transactions against the same nonce.
  assert.equal(prepareCalls, 1, `prepared ${prepareCalls} times`);
  assert.equal(broadcastCalls, 1, `broadcast ${broadcastCalls} times`);
  assert.equal(listArmedMints().length, 0, "a fired mint must be removed");
});

test("a prepare slower than the tick is never started twice", async () => {
  reset();
  // 2.5s is the measured real cost of prepareSignedMints against this RPC,
  // and the tick is 1s — so this is the ordinary case, not a pathological one.
  prepareDelayMs = 2500;
  arm(4000);
  const stop = startMintScheduler({ notify: async () => {} });
  try {
    await wait(6000);
  } finally {
    stop();
  }
  assert.equal(prepareCalls, 1, `prepared ${prepareCalls} times — overlapping ticks re-entered prepare`);
  assert.equal(broadcastCalls, 1, `broadcast ${broadcastCalls} times`);
});

test("it does not fire before the phase opens", async () => {
  reset();
  arm(60_000); // inside the prepare lead, far outside the fire window
  const stop = startMintScheduler({ notify: async () => {} });
  try {
    await wait(2500);
    assert.equal(broadcastCalls, 0, "fired early");
    assert.ok(prepareCalls >= 1, "should have prepared ahead of the open");
    assert.equal(listArmedMints()[0]?.prepared, true);
  } finally {
    stop();
  }
});

test("a failed prepare does not retry once per tick", async () => {
  reset();
  prepareResult = { ok: false, reason: "Unit price unknown.", signed: [] };
  arm(6000);
  const stop = startMintScheduler({ notify: async () => {} });
  try {
    await wait(4000);
  } finally {
    stop();
  }
  // Retrying is right; retrying at 1Hz for the whole 90s lead is a stampede
  // against the RPC we depend on being responsive at the open.
  assert.ok(prepareCalls <= 3, `prepare retried ${prepareCalls} times in 4s`);
  assert.ok(prepareCalls >= 1, "should have tried at least once");
});

test("nothing prepared means nothing is fired", async () => {
  reset();
  prepareResult = { ok: false, reason: "No wallets imported.", signed: [] };
  arm(1500);
  const stop = startMintScheduler({ notify: async () => {} });
  try {
    await wait(3500);
  } finally {
    stop();
  }
  assert.equal(broadcastCalls, 0, "fired with nothing prepared");
});

test("disarming stops it firing", async () => {
  reset();
  arm(2000);
  const stop = startMintScheduler({ notify: async () => {} });
  try {
    await wait(500);
    assert.equal(disarmMint("robinhood", ADDR), true);
    await wait(2500);
  } finally {
    stop();
  }
  assert.equal(broadcastCalls, 0);
});

test("arming writes the intention to disk", () => {
  reset();
  arm(600_000);
  const saved = JSON.parse(fs.readFileSync(storePath, "utf8"));
  assert.equal(saved.armed.length, 1);
  assert.equal(saved.armed[0].contractAddress, ADDR);
  // Signed transactions must NEVER be persisted — a signature carries a
  // nonce that will be stale after a restart, and storing one invites
  // firing it.
  assert.equal(saved.armed[0].signed, undefined);
  assert.equal(saved.armed[0].prepared, undefined);
});

test("disarming removes it from disk", () => {
  reset();
  arm(600_000);
  disarmMint("robinhood", ADDR);
  assert.equal(JSON.parse(fs.readFileSync(storePath, "utf8")).armed.length, 0);
});

test("a mint armed before a restart is restored", async () => {
  reset();
  // Written directly, which is exactly the state a restart leaves behind.
  const opensAt = Date.now() + 600_000;
  fs.writeFileSync(storePath, JSON.stringify({ armed: [{ chainKey: "robinhood", contractAddress: ADDR, quantity: 2, walletCount: 1, priceOverrideWei: null, chatId: 1, startsAtMs: opensAt }] }));
  const stop = startMintScheduler({ notify: async () => {} });
  try {
    const list = listArmedMints();
    assert.equal(list.length, 1, "armed mint was lost across the restart");
    assert.equal(list[0].quantity, 2);
    assert.equal(list[0].prepared, false, "nothing signed may survive a restart");
  } finally {
    stop();
    reset();
  }
});

test("a mint whose phase opened while the bot was down is reported, not fired", async () => {
  reset();
  const notes = [];
  fs.writeFileSync(storePath, JSON.stringify({ armed: [{ chainKey: "robinhood", contractAddress: ADDR, quantity: 1, walletCount: 1, priceOverrideWei: null, chatId: 1, startsAtMs: Date.now() - 60_000 }] }));
  const stop = startMintScheduler({ notify: async (_chat, text) => notes.push(text) });
  try {
    await wait(1500);
    // Firing into a window that opened at an unknown point in the past is a
    // decision, not a schedule — the same reason armMint refuses an
    // already-open phase.
    assert.equal(broadcastCalls, 0, "fired a mint whose window opened while down");
    assert.equal(listArmedMints().length, 0);
    assert.ok(notes.some((n) => /while the bot was restarting/.test(n)), `no notification: ${JSON.stringify(notes)}`);
  } finally {
    stop();
    reset();
  }
});

test("an unparseable store degrades to empty rather than crashing the boot", () => {
  reset();
  fs.writeFileSync(storePath, "{ not json");
  const stop = startMintScheduler({ notify: async () => {} });
  stop();
  assert.equal(listArmedMints().length, 0);
});

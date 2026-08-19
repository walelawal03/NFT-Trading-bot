// The contract-creator cache: the one change that meaningfully raises the
// Blockscout ceiling without buying quota. A creator is immutable, so a
// successful lookup is an answer forever — and the property that matters is
// that a cache hit makes NO network call at all, because the quota is about
// ten requests per twenty-six minutes per host.
//
// Run: node --experimental-test-module-mocks tests/contractCreatorCache.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { mock } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Isolated database, so this never reads or writes the real one.
process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "creator-cache-"));
process.env.TELEGRAM_BOT_TOKEN = "111:offline";
process.env.TELEGRAM_CHAT_ID = "1";
process.env.ADMIN_USER_ID = "1";
// No key, so the Etherscan branch short-circuits to the Blockscout fallback
// and this suite tests the path it means to. Empty string, not delete —
// config.js loads dotenv, which would otherwise hand back the real key.
process.env.ETHERSCAN_API_KEY = "";

let fetchCalls = 0;
let respond = () => ({
  ok: true,
  status: 200,
  headers: new Map([["x-ratelimit-remaining", "9"]]),
  json: async () => ({ status: "1", result: [{ contractCreator: "0xDEadBeef00000000000000000000000000000001", txHash: "0xcreation" }] }),
  text: async () => "",
});

mock.module(new URL("../node_modules/node-fetch/src/index.js", import.meta.url).href, {
  defaultExport: async () => {
    fetchCalls++;
    return respond();
  },
});

const { getContractCreator } = await import("../src/risk/explorer.js");
const { getCachedContractCreator, cacheContractCreator } = await import("../src/store/db.js");

const CHAIN = { key: "robinhood", etherscanChainId: 4663, blockscoutBaseUrl: "https://robinhoodchain.blockscout.com" };
const ADDR = "0x819ca7ccc7DA4b78441d2c0c51b89be034174917";

test("a miss hits the network, a hit does not", async () => {
  fetchCalls = 0;
  const first = await getContractCreator(CHAIN, ADDR);
  assert.equal(first.ok, true);
  assert.equal(first.deployerAddress, "0xDEadBeef00000000000000000000000000000001");
  assert.equal(fetchCalls, 1, "first lookup should reach the explorer");

  const second = await getContractCreator(CHAIN, ADDR);
  assert.equal(second.ok, true);
  assert.equal(second.deployerAddress, first.deployerAddress);
  assert.equal(second.cached, true);
  // The whole point. Anything above 1 means quota is still being spent on a
  // question already answered.
  assert.equal(fetchCalls, 1, `cache hit still made ${fetchCalls - 1} network call(s)`);
});

test("the creation tx survives the round trip", async () => {
  const row = getCachedContractCreator("robinhood", ADDR);
  assert.equal(row.creationTx, "0xcreation");
  const viaApi = await getContractCreator(CHAIN, ADDR);
  assert.equal(viaApi.creationTxHash, "0xcreation");
});

test("lookups are case-insensitive on the address", () => {
  // The caller may pass checksum or lowercase; a row must never be missed by
  // the very function that wrote it.
  assert.ok(getCachedContractCreator("robinhood", ADDR.toLowerCase()));
  assert.ok(getCachedContractCreator("robinhood", ADDR.toUpperCase().replace("0X", "0x")));
});

test("the cache is per chain, not global", () => {
  // The same address is a different contract on a different chain.
  assert.equal(getCachedContractCreator("base", ADDR), null);
});

test("a rate-limited lookup is never cached", async () => {
  fetchCalls = 0;
  const OTHER = "0x1111111111111111111111111111111111111111";
  respond = () => ({
    ok: false,
    status: 429,
    headers: new Map([["x-ratelimit-remaining", "0"]]),
    json: async () => ({}),
    text: async () => "rate limited",
  });
  const r = await getContractCreator(CHAIN, OTHER);
  assert.equal(r.ok, false);
  // Caching this would freeze one bad minute into a permanent "unknown
  // deployer" for a contract we could have resolved a moment later.
  assert.equal(getCachedContractCreator("robinhood", OTHER), null, "a 429 was cached as an answer");
});

test("a not-found is not cached either", async () => {
  const FRESH = "0x2222222222222222222222222222222222222222";
  respond = () => ({
    ok: true,
    status: 200,
    headers: new Map([["x-ratelimit-remaining", "9"]]),
    json: async () => ({ status: "1", result: [] }),
    text: async () => "",
  });
  const r = await getContractCreator(CHAIN, FRESH);
  assert.equal(r.ok, false);
  // A contract the indexer has not caught up with yet is the NORMAL state for
  // a mint worth underwriting. Caching the miss would make it permanent.
  assert.equal(getCachedContractCreator("robinhood", FRESH), null);
});

test("writing the same creator twice is harmless", () => {
  const A = "0x3333333333333333333333333333333333333333";
  assert.equal(cacheContractCreator("robinhood", A, { deployerAddress: "0xaaa", creationTx: "0x1" }), true);
  assert.equal(cacheContractCreator("robinhood", A, { deployerAddress: "0xbbb", creationTx: "0x2" }), true);
  // First write wins — a creator cannot change, so a later disagreement is
  // noise, not news.
  assert.equal(getCachedContractCreator("robinhood", A).deployerAddress, "0xaaa");
});

test("a missing deployer address is refused rather than stored as null", () => {
  assert.equal(cacheContractCreator("robinhood", "0x4444444444444444444444444444444444444444", { deployerAddress: null }), false);
});

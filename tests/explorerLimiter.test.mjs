// The Blockscout limiter, tested against a stubbed fetch so it never touches
// a real explorer (and never burns the very quota this exists to protect).
//
// The behaviour that matters is not the spacing — it's that a rate-limited
// host stops being asked. The collection watcher hands over a whole poll
// cycle at once, so a queue that politely waits its turn behind 100 doomed
// requests would stall scoring for minutes.
import assert from "node:assert";

// Isolated data dir, so the contract-creator cache this exercises writes to a
// throwaway database rather than the real one. Without it the suite passed on
// a clean DB and failed on the second run: the cached success short-circuited
// the fetch, so the `remaining: 0` header that arms the cooldown was never
// seen. A test that mutates production state is a test that lies once.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
process.env.RAILWAY_VOLUME_MOUNT_PATH = fs.mkdtempSync(path.join(os.tmpdir(), "explorer-limiter-"));

process.env.TELEGRAM_BOT_TOKEN = "111:offline";
process.env.TELEGRAM_CHAT_ID = "1";
process.env.ADMIN_USER_ID = "1";
// No Etherscan key, so getContractCreator goes straight to the Blockscout
// fallback and this suite tests the path it means to.
//
// Empty string, NOT delete: config.js imports dotenv, which only skips keys
// already present in process.env. Deleting the variable hands it straight
// back from the developer's real .env, and then the Etherscan branch runs
// against this suite's stub and throws on the 429 before Blockscout is ever
// reached — which reads as a limiter bug rather than a leaked key.
process.env.ETHERSCAN_API_KEY = "";

// node-fetch is stubbed before explorer.js imports it.
const { mock } = await import("node:test");
let calls = [];
let respond = () => ({ status: 200, headers: new Map(), body: { status: "1", result: [{ contractCreator: "0xdead", txHash: "0xtx" }] } });

mock.module(new URL("../node_modules/node-fetch/src/index.js", import.meta.url).href, {
  defaultExport: async (url) => {
    calls.push({ url: String(url), at: Date.now() });
    const r = respond();
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k) => r.headers.get(k) ?? null },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  },
});

const { getContractCreator } = await import("../src/risk/explorer.js");

const chain = (key, host) => ({ key, etherscanChainId: 999999, blockscoutBaseUrl: host });
const okHeaders = (remaining) => new Map(remaining == null ? [] : [["x-ratelimit-remaining", String(remaining)]]);

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

console.log("\nexplorerLimiter\n");

await t("a normal lookup resolves the deployer", async () => {
  calls = [];
  respond = () => ({ status: 200, headers: okHeaders(9), body: { status: "1", result: [{ contractCreator: "0xabc", txHash: "0xt" }] } });
  const r = await getContractCreator(chain("c1", "https://host-one.test"), "0xcontract");
  assert.equal(r.ok, true);
  assert.equal(r.deployerAddress, "0xabc");
});

await t("an empty result is not_found, not an error — a fresh contract isn't indexed yet", async () => {
  respond = () => ({ status: 200, headers: okHeaders(9), body: { status: "1", result: [] } });
  const r = await getContractCreator(chain("c2", "https://host-two.test"), "0xcontract");
  assert.equal(r.ok, false);
  assert.equal(r.reason, "not_found");
});

// The core property. One 429 must take the host out of rotation, so the
// remaining collections in the batch fail instantly instead of queueing.
await t("after a 429, further lookups fail fast without another request", async () => {
  respond = () => ({ status: 429, headers: okHeaders(0), body: { status: "0", result: null } });
  const host = "https://host-three.test";
  const first = await getContractCreator(chain("c3", host), "0xone");
  assert.equal(first.reason, "rate_limited");

  calls = [];
  const t0 = Date.now();
  const results = [];
  for (const a of ["0x2", "0x3", "0x4", "0x5", "0x6"]) results.push(await getContractCreator(chain("c3", host), a));
  const elapsed = Date.now() - t0;

  assert.ok(results.every((r) => r.reason === "rate_limited"), "all should report rate_limited");
  assert.equal(calls.length, 0, `cooling host must not be contacted again, saw ${calls.length} requests`);
  assert.ok(elapsed < 200, `must fail fast, took ${elapsed}ms — a stalled batch is the thing this prevents`);
});

// Two Blockscout deployments, two independent quotas.
await t("one host cooling down does not silence another", async () => {
  respond = () => ({ status: 429, headers: okHeaders(0), body: { status: "0", result: null } });
  await getContractCreator(chain("c4", "https://cold.test"), "0xa");

  respond = () => ({ status: 200, headers: okHeaders(5), body: { status: "1", result: [{ contractCreator: "0xfeed", txHash: "0xt" }] } });
  const warm = await getContractCreator(chain("c5", "https://warm.test"), "0xb");
  assert.equal(warm.ok, true, "a healthy host must keep serving while another is cooling");
  assert.equal(warm.deployerAddress, "0xfeed");
});

// remaining:0 alongside a 200 means the NEXT one is doomed. Spending it just
// to be told 429 wastes a request from a 10-per-window budget.
await t("remaining:0 on a success still starts the cooldown", async () => {
  const host = "https://host-exhausted.test";
  respond = () => ({ status: 200, headers: okHeaders(0), body: { status: "1", result: [{ contractCreator: "0x1", txHash: "0xt" }] } });
  const first = await getContractCreator(chain("c6", host), "0xa");
  assert.equal(first.ok, true, "this request itself still succeeded");

  calls = [];
  const next = await getContractCreator(chain("c6", host), "0xb");
  assert.equal(next.reason, "rate_limited");
  assert.equal(calls.length, 0, "should not spend a request to learn what the counter already said");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

// The filter is now load-bearing: before this change every threshold was a
// no-op, so nothing it did could be wrong. These cases pin the two things
// that are easy to get backwards — gates failing OPEN when a config is old,
// and market thresholds silently rejecting every mint.
//
// Runs against a throwaway data dir so it never reads or writes the real
// nftFilters.json.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TELEGRAM_BOT_TOKEN ||= "111:dummy";
process.env.TELEGRAM_CHAT_ID ||= "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nftfilter-"));
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmp;

const { loadNftFilters, saveNftFilters, applyNftFilter } = await import("../src/filters/nftFilter.js");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

console.log("\nnftFilter\n");

// A clean mint: scan passed, no market data at all. This is the shape of
// nearly every collection the bot underwrites.
const cleanMint = {
  score: 51,
  security: null,
  stats: null,
  collection: null,
  totalSupply: null,
  contractVerdict: { fatal: false, unknown: false, deduction: 0, flags: [] },
};
const withVerdict = (v, over = {}) => ({ ...cleanMint, ...over, contractVerdict: { ...cleanMint.contractVerdict, ...v } });

t("a clean brand-new collection passes with no market data", () => {
  saveNftFilters(loadNftFilters());
  const r = applyNftFilter(cleanMint, { source: "new_collection" });
  assert.ok(r.pass, `expected pass, got: ${r.reasons.join(" | ")}`);
});

// The trap that kept every threshold pinned at 0. Ownership checks used to
// run unconditionally, so any non-zero minOwnerCount blocked all mints.
t("market thresholds never reject a brand-new collection", () => {
  const f = loadNftFilters();
  saveNftFilters({ ...f, minOwnerCount: 500, maxOwnerConcentrationPercent: 1, minFloorPriceEth: 10, minVolume24hEth: 10 });
  const r = applyNftFilter(cleanMint, { source: "new_collection" });
  assert.ok(r.pass, `mint was rejected on market data it cannot have: ${r.reasons.join(" | ")}`);
  saveNftFilters(f);
});

t("the same thresholds do apply to a secondary-market call", () => {
  const f = loadNftFilters();
  saveNftFilters({ ...f, minOwnerCount: 500 });
  const r = applyNftFilter({ ...cleanMint, stats: { numOwners: 3, floorPriceEth: 1, volume24hEth: 1 } }, { source: "copy_trade" });
  assert.equal(r.pass, false, "copy_trade has a real market and must be gated on it");
  assert.ok(r.reasons.some((x) => /Owner count/.test(x)));
  saveNftFilters(f);
});

t("a fatal contract is rejected with the capability named, not just a score", () => {
  const r = applyNftFilter(
    withVerdict({ fatal: true, flags: ["🚨 Named holders can be blocked: blacklist(address) — a seller can be singled out at exit"] }, { score: 0 }),
    { source: "new_collection" }
  );
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some((x) => /blacklist\(address\)/.test(x)), `reason should name the capability: ${r.reasons.join(" | ")}`);
});

t("an unreadable contract is rejected rather than treated as clean", () => {
  const r = applyNftFilter(withVerdict({ unknown: true, deduction: 17 }, { score: 34 }), { source: "new_collection" });
  assert.equal(r.pass, false);
  assert.ok(r.reasons.some((x) => /unknown/i.test(x)));
});

// The fail-open this is guarding: a volume holding a pre-existing
// nftFilters.json has neither new key, and `undefined && fatal` is falsy.
t("contract gates stay ON for a config file written before they existed", () => {
  fs.writeFileSync(
    path.join(tmp, "nftFilters.json"),
    JSON.stringify({ minFloorPriceEth: 0, maxFloorPriceEth: 5, minRiskScore: 0, blockMalicious: true })
  );
  const f = loadNftFilters();
  assert.equal(f.blockFatalContract, true, "a missing gate must default ON, never off");
  assert.equal(f.blockUnknownContract, true);

  const r = applyNftFilter(withVerdict({ fatal: true, flags: ["🚨 seize(uint256)"] }, { score: 0 }), { source: "new_collection" });
  assert.equal(r.pass, false, "an old config must not silently disarm the hard gate");
});

t("an explicit false in the config still wins over the default", () => {
  fs.writeFileSync(path.join(tmp, "nftFilters.json"), JSON.stringify({ ...loadNftFilters(), blockUnknownContract: false }));
  assert.equal(loadNftFilters().blockUnknownContract, false, "defaults must not override a deliberate opt-out");
  const r = applyNftFilter(withVerdict({ unknown: true }, { score: 51 }), { source: "new_collection" });
  assert.ok(r.pass, "with the gate off, an unknown scan should no longer block");
});

// Best-effort teardown; see deployerRecord.test.mjs for why this can throw.
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

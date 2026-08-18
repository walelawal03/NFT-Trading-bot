// Deployer reputation must come from what happened, not from what we said.
// NFT collections only — the token pipeline is a separate bot and out of
// scope for this repo.
//
// Runs against a throwaway SQLite file (RAILWAY_VOLUME_MOUNT_PATH points at
// a temp dir), so it never touches data/bot.sqlite. No network, no env
// beyond the Telegram vars config.js insists on.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TELEGRAM_BOT_TOKEN ||= "111:dummy";
process.env.TELEGRAM_CHAT_ID ||= "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nftdeployer-"));
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmp;

const db = await import("../src/store/db.js");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

console.log("\nnftDeployerRecord\n");

let seq = 0;
const nextDeployer = () => `0xdep${String(++seq).padStart(37, "0")}`;

// Each case gets its own deployer. The scan suite learned this the hard
// way: reusing one address made nine of eleven cases pass vacuously.
function callFor(deployer, { floor = 1, outcomePct = null, horizon = "7d", kind = "owner" }) {
  const contract = `0xc0ffee${String(++seq).padStart(34, "0")}`;
  db.recordNftCall({
    chain: "base", contractAddress: contract, collectionSlug: `slug-${seq}`, name: `n${seq}`,
    imageUrl: null, callFloorPriceEth: floor, callVolume24hEth: 0, callNumOwners: 1,
    callTotalSupply: 1, riskScore: 50, riskGrade: "C", source: "new_collection",
    triggerWalletAddress: null, telegramMessageId: null, calledAt: Date.now(),
    deployerAddress: deployer, controllerKind: kind,
  });
  if (outcomePct !== null) {
    const row = db.getNftCallsPendingOutcome(Date.now() + 1, horizon).find((r) => r.contract_address === contract);
    assert.ok(row, "call should be eligible for an outcome");
    db.recordNftCallOutcome(row.id, { outcomeFloorEth: floor * (1 + outcomePct / 100), outcomePct }, horizon);
  }
  return contract;
}

t("a deployer we have never settled an outcome for is unknown, not clean", () => {
  const r = db.getNftControllerRealizedRecord(nextDeployer(), { kind: "owner" });
  assert.equal(r.collections, 0);
  assert.equal(r.ruggedRatio, null, "null, so the caller cannot read it as 0% rugged");
});

t("a call with no resolved outcome does not count as a good record", () => {
  const d = nextDeployer();
  callFor(d, { outcomePct: null });
  const r = db.getNftControllerRealizedRecord(d, { kind: "owner" });
  assert.equal(r.collections, 0, "pending is not evidence in either direction");
});

t("realized drawdown past the threshold counts as rugged", () => {
  const d = nextDeployer();
  callFor(d, { outcomePct: -80 });
  callFor(d, { outcomePct: 15 });
  const r = db.getNftControllerRealizedRecord(d, { kind: "owner" });
  assert.equal(r.collections, 2);
  assert.equal(r.rugged, 1);
  assert.equal(r.ruggedRatio, 0.5);
  assert.equal(r.worstPct, -80);
});

t("a drawdown short of the threshold is not a rug", () => {
  const d = nextDeployer();
  callFor(d, { outcomePct: -55 });
  const r = db.getNftControllerRealizedRecord(d, { kind: "owner" });
  assert.equal(r.collections, 1);
  assert.equal(r.rugged, 0, "-55% is a bad call, not a rug label");
});

t("the rug threshold is a parameter, not a constant", () => {
  const d = nextDeployer();
  callFor(d, { outcomePct: -55 });
  assert.equal(db.getNftControllerRealizedRecord(d, { kind: "owner", ruggedBelowPct: -50 }).rugged, 1);
  assert.equal(db.getNftControllerRealizedRecord(d, { kind: "owner", ruggedBelowPct: -60 }).rugged, 0);
});

t("deployer lookup is case-insensitive", () => {
  const d = nextDeployer();
  callFor(d, { outcomePct: -90 });
  const upper = db.getNftControllerRealizedRecord(d.toUpperCase().replace("0X", "0x"), { kind: "owner" });
  assert.equal(upper.collections, 1, "a checksummed address must find the same record");
});

// The loop this replaced could not have had this property: our own score
// was an input to itself, so a deployer's record moved when our opinion
// moved, with nothing on-chain changing.
t("one deployer's outcomes never leak into another's record", () => {
  const a = nextDeployer(), b = nextDeployer();
  callFor(a, { outcomePct: -95 });
  callFor(b, { outcomePct: 40 });
  assert.equal(db.getNftControllerRealizedRecord(a, { kind: "owner" }).rugged, 1);
  assert.equal(db.getNftControllerRealizedRecord(b, { kind: "owner" }).rugged, 0);
  assert.equal(db.getNftControllerRealizedRecord(b, { kind: "owner" }).collections, 1);
});

// The point of adding 7d/30d. A 24h snapshot is a flip label; using it as a
// rug label measures launch-day volatility, so it must not reach the
// deployer's record at all.
t("a 24h outcome alone does not build a deployer record", () => {
  const d = nextDeployer();
  callFor(d, { outcomePct: -90, horizon: "24h" });
  const r = db.getNftControllerRealizedRecord(d, { kind: "owner" });
  assert.equal(r.collections, 0, "24h must not stand in for the rug horizon");
});

t("30d supersedes 7d once it settles", () => {
  const d = nextDeployer();
  const contract = callFor(d, { outcomePct: -70, horizon: "7d" });
  assert.equal(db.getNftControllerRealizedRecord(d, { kind: "owner" }).rugged, 1, "7d says rugged");

  // Same row, later horizon: the floor recovered.
  const row = db.getNftCallsPendingOutcome(Date.now() + 1, "30d").find((r) => r.contract_address === contract);
  assert.ok(row, "30d must still be pending after 7d settled — horizons are independent");
  db.recordNftCallOutcome(row.id, { outcomeFloorEth: 1.2, outcomePct: 20 }, "30d");

  const after = db.getNftControllerRealizedRecord(d, { kind: "owner" });
  assert.equal(after.collections, 1, "still one collection, not two");
  assert.equal(after.rugged, 0, "the longest settled horizon wins");
});

t("settling one horizon leaves the others pending", () => {
  const d = nextDeployer();
  const contract = callFor(d, { outcomePct: -30, horizon: "24h" });
  for (const key of ["7d", "30d"]) {
    const still = db.getNftCallsPendingOutcome(Date.now() + 1, key).some((r) => r.contract_address === contract);
    assert.ok(still, `${key} should still be pending after 24h settled`);
  }
  const done = db.getNftCallsPendingOutcome(Date.now() + 1, "24h").some((r) => r.contract_address === contract);
  assert.equal(done, false, "24h should no longer be pending");
});

t("an unknown horizon is rejected rather than silently querying the wrong column", () => {
  assert.throws(() => db.getNftCallsPendingOutcome(Date.now(), "90d"), /Unknown NFT outcome horizon/);
  assert.throws(() => db.recordNftCallOutcome(1, { outcomeFloorEth: 1, outcomePct: 1 }, "1h"), /Unknown NFT outcome horizon/);
});

// owner and deployer are different facts about a collection — ownership
// transfers, deployment doesn't. Pooling them into one record would merge two
// populations behind a single address and quietly invent history.
t("an owner record and a deployer record never pool, even at the same address", () => {
  const addr = nextDeployer();
  callFor(addr, { outcomePct: -95, kind: "owner" });
  callFor(addr, { outcomePct: 30, kind: "deployer" });

  const asOwner = db.getNftControllerRealizedRecord(addr, { kind: "owner" });
  const asDeployer = db.getNftControllerRealizedRecord(addr, { kind: "deployer" });

  assert.equal(asOwner.collections, 1, "owner record must see only owner rows");
  assert.equal(asOwner.rugged, 1);
  assert.equal(asDeployer.collections, 1, "deployer record must see only deployer rows");
  assert.equal(asDeployer.rugged, 0);
});

// Rows written before controller_kind existed have NULL and cannot be
// attributed to either key. Counting them as one or the other would be a
// guess presented as history.
t("rows with no recorded kind match neither", () => {
  const addr = nextDeployer();
  callFor(addr, { outcomePct: -99, kind: null });
  assert.equal(db.getNftControllerRealizedRecord(addr, { kind: "owner" }).collections, 0);
  assert.equal(db.getNftControllerRealizedRecord(addr, { kind: "deployer" }).collections, 0);
});

// Best-effort teardown. node:sqlite keeps the file handle open for the life
// of the process and Windows refuses to unlink an open file, so this throws
// there — which must not turn a green run red. The directory is under
// os.tmpdir() either way.
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

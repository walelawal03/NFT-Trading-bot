// Deployer reputation must come from what happened, not from what we said.
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
function callFor(deployer, { floor = 1, outcomePct = null }) {
  const contract = `0xc0ffee${String(++seq).padStart(34, "0")}`;
  db.recordNftCall({
    chain: "base", contractAddress: contract, collectionSlug: `slug-${seq}`, name: `n${seq}`,
    imageUrl: null, callFloorPriceEth: floor, callVolume24hEth: 0, callNumOwners: 1,
    callTotalSupply: 1, riskScore: 50, riskGrade: "C", source: "new_collection",
    triggerWalletAddress: null, telegramMessageId: null, calledAt: Date.now(),
    deployerAddress: deployer,
  });
  if (outcomePct !== null) {
    const row = db.getNftCallsPendingOutcome(Date.now() + 1).find((r) => r.contract_address === contract);
    assert.ok(row, "call should be eligible for an outcome");
    db.recordNftCallOutcome(row.id, { outcomeFloorEth: floor * (1 + outcomePct / 100), outcomePct });
  }
  return contract;
}

t("a deployer we have never settled an outcome for is unknown, not clean", () => {
  const r = db.getNftDeployerRealizedRecord(nextDeployer());
  assert.equal(r.collections, 0);
  assert.equal(r.ruggedRatio, null, "null, so the caller cannot read it as 0% rugged");
});

t("a call with no resolved outcome does not count as a good record", () => {
  const d = nextDeployer();
  callFor(d, { outcomePct: null });
  const r = db.getNftDeployerRealizedRecord(d);
  assert.equal(r.collections, 0, "pending is not evidence in either direction");
});

t("realized drawdown past the threshold counts as rugged", () => {
  const d = nextDeployer();
  callFor(d, { outcomePct: -80 });
  callFor(d, { outcomePct: 15 });
  const r = db.getNftDeployerRealizedRecord(d);
  assert.equal(r.collections, 2);
  assert.equal(r.rugged, 1);
  assert.equal(r.ruggedRatio, 0.5);
  assert.equal(r.worstPct, -80);
});

t("a drawdown short of the threshold is not a rug", () => {
  const d = nextDeployer();
  callFor(d, { outcomePct: -55 });
  const r = db.getNftDeployerRealizedRecord(d);
  assert.equal(r.collections, 1);
  assert.equal(r.rugged, 0, "-55% is a bad call, not a rug label");
});

t("the rug threshold is a parameter, not a constant", () => {
  const d = nextDeployer();
  callFor(d, { outcomePct: -55 });
  assert.equal(db.getNftDeployerRealizedRecord(d, { ruggedBelowPct: -50 }).rugged, 1);
  assert.equal(db.getNftDeployerRealizedRecord(d, { ruggedBelowPct: -60 }).rugged, 0);
});

t("deployer lookup is case-insensitive", () => {
  const d = nextDeployer();
  callFor(d, { outcomePct: -90 });
  const upper = db.getNftDeployerRealizedRecord(d.toUpperCase().replace("0X", "0x"));
  assert.equal(upper.collections, 1, "a checksummed address must find the same record");
});

// The loop this replaced could not have had this property: our own score
// was an input to itself, so a deployer's record moved when our opinion
// moved, with nothing on-chain changing.
t("one deployer's outcomes never leak into another's record", () => {
  const a = nextDeployer(), b = nextDeployer();
  callFor(a, { outcomePct: -95 });
  callFor(b, { outcomePct: 40 });
  assert.equal(db.getNftDeployerRealizedRecord(a).rugged, 1);
  assert.equal(db.getNftDeployerRealizedRecord(b).rugged, 0);
  assert.equal(db.getNftDeployerRealizedRecord(b).collections, 1);
});

// Best-effort teardown. node:sqlite keeps the file handle open for the life
// of the process and Windows refuses to unlink an open file, so this throws
// there — which must not turn a green run red. The directory is under
// os.tmpdir() either way.
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

// Wallet roster. Runs against a throwaway data dir so it never reads or
// writes a real mintWallets.json.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet } from "ethers";

process.env.TELEGRAM_BOT_TOKEN = "111:offline";
process.env.TELEGRAM_CHAT_ID = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mintwallets-"));
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmp;

const m = await import("../src/mint/mintWallets.js");

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

console.log("\nmintWallets\n");

const k1 = Wallet.createRandom().privateKey;
const k2 = Wallet.createRandom().privateKey;

t("an empty roster reads as empty rather than throwing", () => {
  assert.deepEqual(m.listMintWallets(), []);
  assert.equal(m.countMintWallets(), 0);
});

t("imports several keys from one paste", () => {
  const r = m.importMintWallets(`${k1}\n${k2}`);
  assert.equal(r.filter((x) => x.ok).length, 2);
  assert.equal(m.countMintWallets(), 2);
});

// A paste of five keys where the third has a stray character should import
// four and say which line failed — not reject the batch and invite a
// re-paste of everything.
t("one bad line does not reject the whole batch", () => {
  const k3 = Wallet.createRandom().privateKey;
  const r = m.importMintWallets(`${k3}\nnot-a-key`);
  assert.equal(r.filter((x) => x.ok).length, 1);
  const bad = r.find((x) => !x.ok);
  assert.equal(bad.reason, "not a valid private key");
  assert.equal(bad.line, 2, "must identify the failing line");
});

// Rejections must never echo the line's contents: the original message is
// deleted on arrival, and quoting it back would put a real key into chat
// history after the fact.
t("a rejection never contains the offending text", () => {
  const r = m.importMintWallets("0xdeadbeefsecretkeymaterial");
  const bad = r.find((x) => !x.ok);
  assert.ok(!JSON.stringify(bad).includes("deadbeefsecret"), "rejection leaked the input");
});

t("re-importing the same key is refused, not duplicated", () => {
  const before = m.countMintWallets();
  const r = m.importMintWallets(k1);
  assert.equal(r[0].ok, false);
  assert.equal(r[0].reason, "already imported");
  assert.equal(m.countMintWallets(), before);
});

// The configuration UI must be structurally unable to leak a key.
t("the public listing exposes addresses only, never private keys", () => {
  const listed = m.listMintWallets();
  assert.ok(listed.length > 0);
  const blob = JSON.stringify(listed);
  assert.ok(!blob.includes("privateKey"), "listing exposed a privateKey field");
  for (const k of [k1, k2]) assert.ok(!blob.includes(k), "listing leaked key material");
});

t("signing keys are reachable only through the explicitly-named function", () => {
  const keys = m.loadMintWalletSigningKeys();
  assert.ok(keys.includes(k1) && keys.includes(k2));
});

t("removal is by address and reports whether it matched", () => {
  const addr = new Wallet(k1).address;
  assert.equal(m.removeMintWallet(addr.toLowerCase()), true, "must match case-insensitively");
  assert.equal(m.removeMintWallet(addr), false, "second removal finds nothing");
  assert.ok(!m.listMintWallets().some((w) => w.address === addr));
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

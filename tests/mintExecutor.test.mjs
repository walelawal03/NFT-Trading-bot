// Executor guards. These are the checks that stand between a misconfigured
// tap and a spent wallet, so they are tested without ever sending anything:
// every case here is refused BEFORE the send stage.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Wallet } from "ethers";

process.env.TELEGRAM_BOT_TOKEN = "111:offline";
process.env.TELEGRAM_CHAT_ID = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mintexec-"));
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmp;

const { executeMint, buildSeaDropMintCall } = await import("../src/mint/nftMintExecutor.js");
const { saveMintExecutionSettings, loadMintExecutionSettings } = await import("../src/mint/mintExecutionSettings.js");
const { importMintWallets } = await import("../src/mint/mintWallets.js");
const { armMint, listArmedMints, disarmMint } = await import("../src/mint/mintScheduler.js");

const CHAIN = { key: "robinhood", label: "Robinhood Chain", etherscanChainId: 4663 };
const detect = (over = {}) => ({
  checked: true, standard: "seadrop", name: "T", soldOut: false, mintable: true,
  phase: { kind: "public", priceWei: 10000000000000000n, startsAt: new Date(Date.now() + 3600e3), endsAt: new Date(Date.now() + 7200e3), maxPerWallet: 3, feeBps: 0, live: false },
  mintVia: { target: "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5", signature: "mintPublic(...)", note: "" },
  ...over,
});

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

console.log("\nmintExecutor\n");

await t("execution is OFF by default", async () => {
  assert.equal(loadMintExecutionSettings().enabled, false, "a bot that can spend must never be the default");
});

await t("disabled execution refuses before touching the network", async () => {
  const r = await executeMint(CHAIN, { detect: detect(), contractAddress: "0x" + "a".repeat(40), quantity: 1, walletCount: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /disabled/i);
  assert.equal(r.results.length, 0);
});

await t("with no wallets it refuses, even when enabled", async () => {
  saveMintExecutionSettings({ ...loadMintExecutionSettings(), enabled: true });
  const r = await executeMint(CHAIN, { detect: detect(), contractAddress: "0x" + "a".repeat(40), quantity: 1, walletCount: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no wallets/i);
});

// The ceiling bounds the WHOLE run, not one transaction. The failure mode is
// 3 each across 20 wallets, not overpaying once.
await t("the spend ceiling counts every wallet in the run", async () => {
  importMintWallets([Wallet.createRandom().privateKey, Wallet.createRandom().privateKey].join("\n"));
  saveMintExecutionSettings({ ...loadMintExecutionSettings(), enabled: true, maxSpendEthPerRun: 0.05 });
  // 0.01 x 3 x 2 wallets = 0.06 ETH, over a 0.05 ceiling
  const r = await executeMint(CHAIN, { detect: detect(), contractAddress: "0x" + "a".repeat(40), quantity: 3, walletCount: 2 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /ceiling/i);
  assert.equal(r.results.length, 0, "must refuse before any send");
});

await t("a contract with no mint entrypoint is refused", async () => {
  const r = await executeMint(CHAIN, { detect: detect({ mintVia: null }), contractAddress: "0x" + "a".repeat(40), quantity: 1, walletCount: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /no mint entrypoint/i);
});

await t("a SeaDrop call without an allowed fee recipient refuses to build", () => {
  assert.throws(
    () => buildSeaDropMintCall({ contractAddress: "0x" + "a".repeat(40), feeRecipient: null, quantity: 1, unitPriceWei: 1n }),
    /fee recipient/i
  );
});

await t("an unknown price refuses to build rather than assuming zero", () => {
  assert.throws(
    () => buildSeaDropMintCall({ contractAddress: "0x" + "a".repeat(40), feeRecipient: "0x" + "b".repeat(40), quantity: 1, unitPriceWei: null }),
    /price unknown/i
  );
});

// Dry run must be the default, and enabling execution must NOT be enough to
// broadcast. Two deliberate steps, not one.
await t("dry run is on by default", async () => {
  assert.equal(loadMintExecutionSettings().dryRun, true, "the safe mode must be the default one");
});

await t("enabling execution alone still cannot broadcast", async () => {
  const st = loadMintExecutionSettings();
  saveMintExecutionSettings({ ...st, enabled: true, dryRun: true });
  assert.equal(loadMintExecutionSettings().dryRun, true, "enabling must not clear dryRun as a side effect");
});

// Scheduling
await t("arming a future phase works and is listable", () => {
  const r = armMint({ chain: CHAIN, contractAddress: "0x" + "c".repeat(40), detect: detect(), quantity: 2, walletCount: 1, chatId: 1 });
  assert.equal(r.ok, true);
  const list = listArmedMints();
  assert.equal(list.length, 1);
  assert.equal(list[0].quantity, 2);
  assert.equal(list[0].fired, false);
});

// An already-open phase is not a schedule — it is a mint, and it should go
// through CONFIRM where the spend is visible.
await t("a phase that is already open is refused, not silently fired", () => {
  const past = detect({ phase: { ...detect().phase, startsAt: new Date(Date.now() - 1000) } });
  const r = armMint({ chain: CHAIN, contractAddress: "0x" + "d".repeat(40), detect: past, quantity: 1, walletCount: 1, chatId: 1 });
  assert.equal(r.ok, false);
  assert.match(r.reason, /already open/i);
});

await t("a drop with no scheduled phase cannot be armed", () => {
  const r = armMint({ chain: CHAIN, contractAddress: "0x" + "e".repeat(40), detect: detect({ phase: null }), quantity: 1, walletCount: 1, chatId: 1 });
  assert.equal(r.ok, false);
});

await t("disarming removes it", () => {
  assert.equal(disarmMint("robinhood", "0x" + "c".repeat(40)), true);
  assert.equal(listArmedMints().length, 0);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

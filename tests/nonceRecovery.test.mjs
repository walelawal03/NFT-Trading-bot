// A pre-signed mint carries its nonce in the signature, so any other
// transaction from the same wallet between preparing and firing invalidates
// it. This happened for real: the first wallet imported turned out to be the
// token bot's trading wallet, which had sent four transactions in the
// preceding hour.
//
// broadcastSigned recovers by re-signing. That path only runs on a rare
// failure, so it is exactly the kind of code that silently rots — hence a
// test that forces it.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { mock } from "node:test";
import { Wallet } from "ethers";

process.env.TELEGRAM_BOT_TOKEN = "111:offline";
process.env.TELEGRAM_CHAT_ID = "1";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "nonce-"));
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmp;

const key = Wallet.createRandom().privateKey;
const address = new Wallet(key).address;

// Provider stub: broadcastTransaction rejects the pre-signed bytes the way a
// node rejects a stale nonce; sendTransaction (the re-sign path) succeeds.
let broadcastCalls = 0;
let sendCalls = 0;
let broadcastError = "nonce too low";
mock.module(new URL("../src/wallet.js", import.meta.url).href, {
  namedExports: {
    getProvider: () => ({
      broadcastTransaction: async () => { broadcastCalls++; throw new Error(broadcastError); },
      getTransactionCount: async () => 205,
      estimateGas: async () => 100000n,
      getFeeData: async () => ({ gasPrice: 1000000n }),
      getNetwork: async () => ({ chainId: 4663n }),
      call: async () => "0x",
    }),
    getLogProvider: () => ({}),
  },
});

const { broadcastSigned } = await import("../src/mint/nftMintExecutor.js");
const { importMintWallets } = await import("../src/mint/mintWallets.js");
const { saveMintExecutionSettings, loadMintExecutionSettings } = await import("../src/mint/mintExecutionSettings.js");

importMintWallets(key);
saveMintExecutionSettings({ ...loadMintExecutionSettings(), enabled: true, dryRun: false });

// ethers Wallet.sendTransaction goes through the provider we stubbed; patch
// the class method so the re-sign path resolves without a real network.
Wallet.prototype.sendTransaction = async function () { sendCalls++; return { hash: "0x" + "d".repeat(64) }; };

const CHAIN = { key: "robinhood", label: "Robinhood Chain", etherscanChainId: 4663 };
const call = { to: "0x" + "a".repeat(40), data: "0x1234", value: 0n };
const signedFixture = () => [{ address, ok: true, raw: "0xdeadbeef", nonce: 119, gasLimit: 150000n, gasPrice: 1000000n, valueWei: 0n }];

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

console.log("\nnonceRecovery\n");

await t("a stale nonce is recovered by re-signing, not reported as a failure", async () => {
  broadcastCalls = 0; sendCalls = 0; broadcastError = "nonce too low";
  const [r] = await broadcastSigned(CHAIN, signedFixture(), { call });
  assert.equal(broadcastCalls, 1, "must try the fast pre-signed path first");
  assert.equal(sendCalls, 1, "must then re-sign once");
  assert.equal(r.ok, true);
  assert.equal(r.stage, "sent-resigned");
  assert.match(r.note, /119 -> 205/, "should say the nonce moved");
});

await t("'already known' is treated as a nonce conflict too", async () => {
  broadcastCalls = 0; sendCalls = 0; broadcastError = "already known";
  const [r] = await broadcastSigned(CHAIN, signedFixture(), { call });
  assert.equal(r.ok, true);
  assert.equal(sendCalls, 1);
});

// A revert is not a nonce problem. Re-signing it would just burn gas twice.
await t("a non-nonce failure is NOT retried", async () => {
  broadcastCalls = 0; sendCalls = 0; broadcastError = "execution reverted: MintQuantityExceeds";
  const [r] = await broadcastSigned(CHAIN, signedFixture(), { call });
  assert.equal(r.ok, false);
  assert.equal(sendCalls, 0, "must not re-send a transaction that reverted on its merits");
  assert.match(r.reason, /MintQuantityExceeds/);
});

await t("without the call there is nothing to re-sign, and it says so", async () => {
  broadcastCalls = 0; sendCalls = 0; broadcastError = "nonce too low";
  const [r] = await broadcastSigned(CHAIN, signedFixture());
  assert.equal(r.ok, false);
  assert.equal(sendCalls, 0);
});

await t("dry run still never broadcasts, stale nonce or not", async () => {
  broadcastCalls = 0; sendCalls = 0;
  saveMintExecutionSettings({ ...loadMintExecutionSettings(), dryRun: true });
  const [r] = await broadcastSigned(CHAIN, signedFixture(), { call });
  assert.equal(r.stage, "dry-run");
  assert.equal(broadcastCalls, 0);
  assert.equal(sendCalls, 0, "the recovery path must not become a way to send during a dry run");
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// The store is redirected to a temp directory BEFORE the module is imported,
// via the same env var dataDir.js already honours in production. Every case
// then wipes the file, because the scan suite once lost nine of eleven cases
// to shared state — each passing vacuously off the first case's result — so
// state carried between cases is treated here as the bug it is.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nft-holdings-"));
process.env.RAILWAY_VOLUME_MOUNT_PATH = dir;

const { recordAcquisition, listRecordedHoldings, forgetHolding } = await import("../src/mint/nftHoldings.js");

const WALLET = "0xd4214c2F7a13Cb0Be01C9A47391035f953E9d59f";
const CONTRACT = "0x819ca7ccc7da4b78441d2c0c51b89be034174917";

const wipe = () => {
  const p = path.join(dir, "nftHoldings.json");
  if (fs.existsSync(p)) fs.unlinkSync(p);
};

test("records one row per token id", () => {
  wipe();
  const added = recordAcquisition({
    chainKey: "robinhood",
    contractAddress: CONTRACT,
    walletAddress: WALLET,
    tokenIds: ["28", "29"],
    name: "prym hood",
    txHash: "0xabc",
  });
  assert.equal(added.length, 2);
  assert.equal(listRecordedHoldings().length, 2);
});

test("re-confirming the same mint does not duplicate", () => {
  wipe();
  const args = {
    chainKey: "robinhood",
    contractAddress: CONTRACT,
    walletAddress: WALLET,
    tokenIds: ["28"],
    txHash: "0xabc",
  };
  recordAcquisition(args);
  const second = recordAcquisition(args);
  assert.equal(second.length, 0);
  assert.equal(listRecordedHoldings().length, 1);
});

test("the same token id in two different wallets is two holdings", () => {
  wipe();
  recordAcquisition({ chainKey: "robinhood", contractAddress: CONTRACT, walletAddress: WALLET, tokenIds: ["1"] });
  recordAcquisition({ chainKey: "robinhood", contractAddress: CONTRACT, walletAddress: "0x000000000000000000000000000000000000dEaD", tokenIds: ["1"] });
  assert.equal(listRecordedHoldings().length, 2);
});

test("price paid survives as an exact wei string, not a float", () => {
  wipe();
  // 0.000123456789012345 ETH — enough digits that a round trip through a
  // JS number would lose the tail, which is how a cost basis quietly stops
  // being the number that was actually paid.
  const wei = 123456789012345n;
  recordAcquisition({ chainKey: "robinhood", contractAddress: CONTRACT, walletAddress: WALLET, tokenIds: ["7"], pricePaidWei: wei });
  assert.equal(listRecordedHoldings()[0].pricePaidWei, "123456789012345");
  assert.equal(BigInt(listRecordedHoldings()[0].pricePaidWei), wei);
});

test("an empty token list writes nothing", () => {
  wipe();
  assert.deepEqual(recordAcquisition({ chainKey: "robinhood", contractAddress: CONTRACT, walletAddress: WALLET, tokenIds: [] }), []);
  assert.equal(listRecordedHoldings().length, 0);
});

test("forgetting is case-insensitive on addresses", () => {
  wipe();
  recordAcquisition({ chainKey: "robinhood", contractAddress: CONTRACT, walletAddress: WALLET, tokenIds: ["28"] });
  assert.equal(
    forgetHolding({ chainKey: "robinhood", contractAddress: CONTRACT.toUpperCase(), tokenId: "28", walletAddress: WALLET.toLowerCase() }),
    true
  );
  assert.equal(listRecordedHoldings().length, 0);
});

test("forgetting something that was never held reports false", () => {
  wipe();
  assert.equal(forgetHolding({ chainKey: "robinhood", contractAddress: CONTRACT, tokenId: "999", walletAddress: WALLET }), false);
});

test("a corrupt store reads as empty rather than throwing", () => {
  // The alternative is a crash on every open of the holdings view — the file
  // is a cache of where to look, so losing it must degrade, not break.
  fs.writeFileSync(path.join(dir, "nftHoldings.json"), "{ this is not json");
  assert.deepEqual(listRecordedHoldings(), []);
});

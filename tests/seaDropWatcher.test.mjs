// Decoding PublicDropUpdated, which is the whole watcher.
//
// This is the one discovery path that finds a Base drop while it is still
// armable — OpenSea indexes those after the mint is usually over (measured
// 2026-08-20: of 24 Base collections the OpenSea watcher had found, 22 were
// closed or sold out and 0 were open).
//
// It is asserted because a wrong decode FAILS QUIETLY. Read the struct with
// the wrong offsets and you get a price of zero and a start time in 1970 —
// both plausible-looking values that would arm a mint against nonsense rather
// than throw. The topic hash has the same property: get it wrong and
// eth_getLogs returns an empty array forever, which looks exactly like "no
// drops right now".
//
// Run: node tests/seaDropWatcher.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { id } from "ethers";

process.env.TELEGRAM_BOT_TOKEN = "111:offline";
process.env.TELEGRAM_CHAT_ID = "1";

const { SEADROP_WATCH } = await import("../src/watchers/seaDropWatcher.js");
const { SEADROP_1_0, PUBLIC_DROP_UPDATED, decodeDrop } = SEADROP_WATCH;

// Each struct field occupies its own 32-byte word — the tuple is NOT packed.
const word = (v) => BigInt(v).toString(16).padStart(64, "0");
const logFor = ({ nft, priceWei, startSec, endSec, maxPerWallet, feeBps, restrict }) => ({
  topics: [PUBLIC_DROP_UPDATED, "0x".padEnd(26, "0") + nft.slice(2)],
  data: "0x" + [priceWei, startSec, endSec, maxPerWallet, feeBps, restrict ? 1 : 0].map(word).join(""),
  blockNumber: 123,
});

const NFT = "0x0164196308f7cf2e9a27ccd0ffd89dfcbc0fb91f";

test("the topic hash matches the real SeaDrop event signature", () => {
  // Verified against live logs on both Base and Robinhood before this shipped.
  // A wrong hash returns an empty result set forever and is indistinguishable
  // from a quiet market.
  assert.equal(
    PUBLIC_DROP_UPDATED,
    id("PublicDropUpdated(address,(uint80,uint48,uint48,uint16,uint16,bool))")
  );
  assert.equal(PUBLIC_DROP_UPDATED, "0x3e30d8e1f739ea4795c481b21c23f905e938b80339305f3508e43c558e5dead3");
});

test("SeaDrop's address matches the one the mint path targets", () => {
  // Two copies of this constant exist by design (nftMintDetect.js has the
  // other) because token and NFT modules stay independently readable — but
  // they must agree, or the watcher finds drops the executor cannot mint.
  assert.equal(SEADROP_1_0, "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5");
});

test("a real drop decodes to the right fields", () => {
  // Shape taken from a live Base log: free, 10000 per wallet.
  const d = decodeDrop(
    logFor({ nft: NFT, priceWei: 0, startSec: 1787250815, endSec: 1789670015, maxPerWallet: 10000, feeBps: 500, restrict: true })
  );
  assert.equal(d.contractAddress.toLowerCase(), NFT.toLowerCase());
  assert.equal(d.priceWei, 0n);
  assert.equal(d.startsAt.toISOString(), "2026-08-20T18:33:35.000Z");
  assert.equal(d.maxPerWallet, 10000);
  assert.equal(d.feeBps, 500);
  assert.equal(d.restrictFeeRecipients, true);
});

test("a priced drop keeps full wei precision", () => {
  // uint80 exceeds Number.MAX_SAFE_INTEGER, so the price must stay a bigint
  // all the way through. Rounding a mint price is a guaranteed revert:
  // SeaDrop requires msg.value == quantity * mintPrice exactly.
  const d = decodeDrop(
    logFor({ nft: NFT, priceWei: 10000000000000000n, startSec: 1787250815, endSec: 0, maxPerWallet: 75, feeBps: 0, restrict: false })
  );
  assert.equal(typeof d.priceWei, "bigint");
  assert.equal(d.priceWei, 10000000000000000n);
  // endTime 0 means "no end", not 1970.
  assert.equal(d.endsAt, null);
});

test("a zero start time is refused rather than read as 1970", () => {
  // The failure mode this whole file exists for: a plausible-looking value
  // that would arm a mint whose phase "opened" 56 years ago.
  assert.equal(
    decodeDrop(logFor({ nft: NFT, priceWei: 0, startSec: 0, endSec: 0, maxPerWallet: 1, feeBps: 0, restrict: false })),
    null
  );
});

test("a truncated log is refused rather than half-decoded", () => {
  assert.equal(decodeDrop({ topics: [PUBLIC_DROP_UPDATED, "0x" + "0".repeat(64)], data: "0x" + word(1) }), null);
});

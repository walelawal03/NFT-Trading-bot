import test from "node:test";
import assert from "node:assert/strict";
import { buildHoldingsText, holdingsKeyboard, openseaCollectionUrl, openseaTokenUrl } from "../src/telegram/formatHoldings.js";

// Offline by construction: formatHoldings reads no chain and no API, so every
// case here is a plain object. The bugs worth catching are the ones that only
// show at the edges — a zero floor, a hostile collection name, a wallet
// holding more than fits in one Telegram message.

const group = (over = {}) => ({
  chainKey: "robinhood",
  contractAddress: "0x819ca7ccc7da4b78441d2c0c51b89be034174917",
  name: "prym hood",
  slug: "prym-hood",
  floorEth: 0.002,
  tokens: [{ tokenId: "28", walletAddress: "0xd4214c2F7a13Cb0Be01C9A47391035f953E9d59f" }],
  ...over,
});

const holdings = (over = {}) => ({
  wallets: [{ index: 0, address: "0xd4214c2F7a13Cb0Be01C9A47391035f953E9d59f", label: null }],
  groups: [group()],
  checked: true,
  partial: false,
  ...over,
});

test("no wallets says so instead of showing an empty list", () => {
  const text = buildHoldingsText({ holdings: holdings({ wallets: [], groups: [] }) });
  assert.match(text, /No mint wallets yet/);
});

test("wallets but nothing held names the wallets that were checked", () => {
  const text = buildHoldingsText({ holdings: holdings({ groups: [] }) });
  assert.match(text, /Nothing held yet across 1 wallet/);
  assert.match(text, /0xd4214c2F7a13Cb0Be01C9A47391035f953E9d59f/);
});

test("a held token is listed with its floor and position", () => {
  const text = buildHoldingsText({ holdings: holdings(), ethUsd: 3000 });
  assert.match(text, /prym hood/);
  assert.match(text, /#28/);
  assert.match(text, /Floor 0\.002 ETH/);
  // 1 token at 0.002 ETH, $3000/ETH -> $6.00 for both floor and position
  assert.match(text, /\$6\.00/);
});

test("an unpriced collection is counted but adds nothing to the total", () => {
  const text = buildHoldingsText({
    holdings: holdings({ groups: [group(), group({ contractAddress: "0xaaa", name: "no floor", floorEth: null, slug: null })] }),
  });
  assert.match(text, /1 collection unpriced/);
  // Total must stay the priced collection's value, not be diluted by a zero.
  assert.match(text, /Value at floor: \*0\.002 ETH\*/);
  assert.match(text, /No floor yet/);
});

test("no floor anywhere says why rather than showing a zero valuation", () => {
  const text = buildHoldingsText({ holdings: holdings({ groups: [group({ floorEth: null })] }) });
  assert.doesNotMatch(text, /Value at floor/);
  assert.match(text, /No floor prices yet/);
});

test("a zero floor is never offered a sell button", () => {
  // OpenSea reports 0 when nothing is listed. priceHoldings normalises that
  // to null, but the keyboard must not depend on that having happened.
  const kb = holdingsKeyboard(holdings({ groups: [group({ floorEth: null })] }));
  const labels = kb.reply_markup.inline_keyboard.flat().map((b) => b.text);
  assert.ok(!labels.some((l) => l.includes("List")), `unexpected sell button: ${labels.join("|")}`);
});

test("a priced collection gets exactly one sell button, indexed to its group", () => {
  const kb = holdingsKeyboard(holdings());
  const buttons = kb.reply_markup.inline_keyboard.flat();
  const sell = buttons.filter((b) => b.callback_data?.startsWith("hold:sell:"));
  assert.equal(sell.length, 1);
  assert.equal(sell[0].callback_data, "hold:sell:0");
});

test("a huge wallet still fits in one Telegram message", () => {
  // 4096 is a hard API limit and it rejects the WHOLE message on overflow —
  // so the pathological case has to be a test, not an assumption.
  const groups = Array.from({ length: 40 }, (_, i) =>
    group({
      contractAddress: `0x${String(i).padStart(40, "0")}`,
      name: `Collection number ${i} with a deliberately long name`,
      tokens: Array.from({ length: 60 }, (_, t) => ({ tokenId: String(t), walletAddress: "0xd4214c2F7a13Cb0Be01C9A47391035f953E9d59f" })),
    })
  );
  const text = buildHoldingsText({ holdings: holdings({ groups }), ethUsd: 3000 });
  assert.ok(text.length < 4096, `message was ${text.length} chars`);
  assert.match(text, /more collections not shown/);
  // The per-collection token list is capped too, and says so.
  assert.match(text, /\+40 more/);
  // The keyboard must stay tappable on a phone rather than growing with the
  // wallet — and every button it does draw must index a real collection.
  const buttons = holdingsKeyboard(holdings({ groups })).reply_markup.inline_keyboard.flat();
  const sell = buttons.filter((b) => b.callback_data?.startsWith("hold:sell:"));
  assert.ok(sell.length <= 6, `${sell.length} sell buttons`);
  for (const b of sell) {
    assert.ok(groups[Number(b.callback_data.split(":")[2])], `button points at a missing group: ${b.callback_data}`);
  }
});

test("markdown markers in a collection name cannot break the message", () => {
  // Collection names come from the contract, which the deployer controls. An
  // unbalanced * or _ makes Telegram reject the entire message.
  const text = buildHoldingsText({ holdings: holdings({ groups: [group({ name: "we_are*legit`drop[" })] }) });
  // Escaped markers still appear as characters, so counting raw occurrences
  // would report the escaping itself as damage. Only UNESCAPED markers can
  // open an entity, so those are what has to balance.
  for (const marker of ["*", "_", "`", "["]) {
    const count = (text.match(new RegExp(`(^|[^\\\\])\\${marker}`, "g")) || []).length;
    assert.equal(count % 2, 0, `unbalanced ${marker} (${count})`);
  }
  assert.match(text, /we\\_are\\\*legit/);
});

test("partial results are stated, not hidden", () => {
  const text = buildHoldingsText({ holdings: holdings({ partial: true }) });
  assert.match(text, /may be incomplete/);
});

test("links point at the collection when a slug is known, the contract when not", () => {
  assert.equal(openseaCollectionUrl(group()), "https://opensea.io/collection/prym-hood");
  assert.equal(
    openseaCollectionUrl(group({ slug: null })),
    "https://opensea.io/assets/robinhood/0x819ca7ccc7da4b78441d2c0c51b89be034174917"
  );
  assert.equal(
    openseaTokenUrl(group(), "28"),
    "https://opensea.io/assets/robinhood/0x819ca7ccc7da4b78441d2c0c51b89be034174917/28"
  );
});

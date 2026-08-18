// Drives the REAL Telegram handlers end to end, offline.
//
// Telegraf is created normally and fed genuine Update objects through
// bot.handleUpdate(), so every layer under test is the shipping one: the
// command parser, the pending-action chain, the keyboards, the Markdown
// builders. The only thing replaced is the outbound HTTP call — telegram
// .callApi is captured instead of sent — so this needs no bot token and
// cannot collide with a live bot polling the same token.
//
// Network-touching handlers (an actual /nftcheck against a live chain) are
// exercised separately in scripts/nftScan.js; here the contract address is
// deliberately one with no code, so the scan resolves fast and locally.
import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.TELEGRAM_BOT_TOKEN ||= "111:offline";
process.env.TELEGRAM_CHAT_ID ||= "424242";
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "tgsmoke-"));
process.env.RAILWAY_VOLUME_MOUNT_PATH = tmp;

// Telegraf builds a FRESH Telegram instance per update, so patching
// bot.telegram.callApi intercepts nothing — the handlers quietly hit the
// real API and fail 401. The prototype is the only seam that covers every
// instance. (Found the hard way: an instance-level stub made all 13 cases
// fail with an empty capture, which reads like broken handlers rather than
// a broken harness.)
const { Telegram } = await import("telegraf");
const sent = [];
Telegram.prototype.callApi = async (method, payload) => {
  sent.push({ method, payload });
  if (method === "sendMessage" || method === "editMessageText") {
    return { message_id: sent.length, chat: { id: Number(process.env.TELEGRAM_CHAT_ID) }, text: payload?.text };
  }
  return true;
};

const { createBot } = await import("../src/telegram/bot.js");

const stats = { called: 0, pending: 0, nftCalled: 0 };
const bot = createBot(stats, { toggleChain() {}, getEnabledKeys: () => [] }, { sendNow: async () => {}, reschedule() {} });

// Telegraf normally fetches this via getMe on launch.
bot.botInfo = { id: 111, is_bot: true, username: "nft_underwriter_bot", first_name: "NFT" };

const CHAT = Number(process.env.TELEGRAM_CHAT_ID);
let updateId = 0;
// Telegraf identifies a command from message.entities, not by the leading
// slash — a fake update without the bot_command entity silently matches no
// handler at all, which looks exactly like a broken command.
const send = async (text) => {
  sent.length = 0;
  const entities = text.startsWith("/")
    ? [{ type: "bot_command", offset: 0, length: text.split(/\s/)[0].length }]
    : undefined;
  await bot.handleUpdate({
    update_id: ++updateId,
    message: { message_id: ++updateId, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" }, from: { id: CHAT, is_bot: false, first_name: "u" }, text, ...(entities && { entities }) },
  });
  return [...sent];
};
const tap = async (data) => {
  sent.length = 0;
  await bot.handleUpdate({
    update_id: ++updateId,
    callback_query: {
      id: String(++updateId), from: { id: CHAT, is_bot: false, first_name: "u" }, chat_instance: "1", data,
      message: { message_id: 1, date: Math.floor(Date.now() / 1000), chat: { id: CHAT, type: "private" }, text: "menu" },
    },
  });
  return [...sent];
};
const texts = (calls) => calls.filter((c) => c.method === "sendMessage" || c.method === "editMessageText").map((c) => c.payload.text).join("\n---\n");

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

console.log("\ntelegramSmoke\n");

await t("/nftcheck with no argument replies with usage, not a crash", async () => {
  const out = texts(await send("/nftcheck"));
  assert.match(out, /Usage: \/nftcheck/);
  assert.match(out, /no OpenSea, no GoPlus/, "usage should say why this command exists");
});

await t("/nftcheck rejects a malformed address", async () => {
  const out = texts(await send("/nftcheck notanaddress"));
  assert.match(out, /Usage: \/nftcheck/);
});

await t("/nftcheck names the chains it accepts and its default", async () => {
  const out = texts(await send("/nftcheck"));
  assert.match(out, /base/);
  assert.match(out, /robinhood/);
  assert.match(out, /defaults to base/);
});

await t("/nftcheck on an address with no code answers, and never implies a pass", async () => {
  const out = texts(await send("/nftcheck base 0x000000000000000000000000000000000000dEaD"));
  assert.match(out, /Reading contract/, "should acknowledge before scanning");
  assert.ok(!/PASSES HARD GATE/i.test(out), `an EOA must not read as a pass:\n${out}`);
});

await t("/nftcheck rejects an unknown chain by name", async () => {
  const out = texts(await send("/nftcheck ethereum 0x000000000000000000000000000000000000dEaD"));
  assert.match(out, /Scan failed: Unknown chain|Usage/, `expected a chain error, got:\n${out}`);
});

await t("the NFT menu offers the contract scan next to the score", async () => {
  const calls = await tap("menu:nft");
  const markup = calls.find((c) => c.payload?.reply_markup)?.payload.reply_markup;
  const labels = JSON.stringify(markup);
  assert.match(labels, /Contract Scan/);
  assert.match(labels, /menu:nftcheck/);
});

await t("tapping Contract Scan prompts for an address", async () => {
  const out = texts(await tap("menu:nftcheck"));
  assert.match(out, /Paste the contract address/);
  assert.match(out, /base/, "should say which chain it will use");
});

await t("the pasted address then routes into the scan, not the scorer", async () => {
  await tap("menu:nftcheck");
  const out = texts(await send("0x000000000000000000000000000000000000dEaD"));
  assert.match(out, /Reading contract/, "must use the scan path");
  assert.ok(!/Analyzing/.test(out), "must not fall through to the OpenSea scorer");
});

await t("the filter menu explains what each group gates", async () => {
  const out = texts(await tap("menu:nftfilter"));
  assert.match(out, /Contract gate/);
  assert.match(out, /Market gate/);
  assert.match(out, /skipped for brand-new collections/);
  assert.match(out, /Minimum risk score: 40/);
});

await t("boolean filters render as checkboxes, numbers as edit buttons", async () => {
  const calls = await tap("menu:nftfilter");
  const markup = JSON.stringify(calls.find((c) => c.payload?.reply_markup)?.payload.reply_markup);
  assert.match(markup, /nftfiltertoggle:blockFatalContract/, "safety gates should be one-tap");
  assert.match(markup, /nftfilteredit:minRiskScore/, "numeric settings keep the prompt");
  assert.match(markup, /✅ blockFatalContract/, "an armed gate should read as armed");
});

await t("tapping a boolean filter actually flips and persists it", async () => {
  const { loadNftFilters } = await import("../src/filters/nftFilter.js");
  const before = loadNftFilters().blockUnknownContract;
  await tap("nftfiltertoggle:blockUnknownContract");
  assert.equal(loadNftFilters().blockUnknownContract, !before, "toggle must persist to disk");
  await tap("nftfiltertoggle:blockUnknownContract");
  assert.equal(loadNftFilters().blockUnknownContract, before, "and flip back");
});

await t("an unknown filter key is refused rather than written", async () => {
  const out = texts(await tap("nftfiltertoggle:notARealKey"));
  assert.match(out, /Unknown filter key/);
});

await t("/nftscore is still present and unchanged", async () => {
  const out = texts(await send("/nftscore"));
  assert.ok(out.length > 0, "/nftscore must still respond");
  assert.ok(!/nftcheck/.test(out), "/nftscore must not have been merged into the scan");
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

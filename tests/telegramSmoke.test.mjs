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

// Set before anything imports config.js, which pulls in dotenv. dotenv does
// not overwrite variables that already exist, so this pins the test's
// identity regardless of what a developer's real .env holds.
//
// ADMIN_USER_ID matters more than it looks: bot.js installs a global
// middleware that DROPS any update whose from.id doesn't match it. Inherit a
// real admin id from .env and every case here silently receives nothing and
// fails with an empty capture — which reads like the handlers are broken.
process.env.TELEGRAM_BOT_TOKEN = "111:offline";
process.env.TELEGRAM_CHAT_ID = "424242";
process.env.ADMIN_USER_ID = "424242";
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
  assert.match(out, /ethereum/);
  assert.match(out, /robinhood/);
  assert.match(out, /defaults to base/);
});

await t("/nftcheck on an address with no code answers, and never implies a pass", async () => {
  const out = texts(await send("/nftcheck base 0x000000000000000000000000000000000000dEaD"));
  assert.match(out, /Reading contract/, "should acknowledge before scanning");
  assert.ok(!/PASSES HARD GATE/i.test(out), `an EOA must not read as a pass:\n${out}`);
});

await t("/nftcheck accepts ethereum mainnet as a chain", async () => {
  const out = texts(await send("/nftcheck ethereum 0x000000000000000000000000000000000000dEaD"));
  assert.ok(!/Unknown chain/i.test(out), `ethereum should now be accepted:\n${out}`);
  assert.match(out, /Reading contract/, "ethereum should go through the scan path");
});

await t("/nftcheck rejects an unknown chain by name", async () => {
  const out = texts(await send("/nftcheck mainnet 0x000000000000000000000000000000000000dEaD"));
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

await t("/watchwallet accepts a Solana public key", async () => {
  const out = texts(await send("/watchwallet So11111111111111111111111111111111111111112 sol-test"));
  assert.match(out, /Now watching/);
  assert.match(out, /So11111111111111111111111111111111111111112/);
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

// Observed live: OpenSea's CDN refuses Telegram's server-side fetch, so every
// call paid a doomed sendPhoto before falling back to text. The host is
// condemned after one such failure — and ONLY for that failure, or an
// unrelated hiccup would silently kill images everywhere forever.
await t("a CDN that refuses Telegram is dropped to text after one failure", async () => {
  const { postNftCall } = await import("../src/telegram/bot.js");
  const riskResult = {
    score: 50, grade: "C", label: "Medium Risk", flags: [],
    breakdown: { contractSafety: 30, marketplaceLiquidity: 0, holderDistribution: 6, deployerHistory: 10 },
    name: "Test", slug: null, stats: null, totalSupply: null,
    imageUrl: "https://i2c.seadn.io/base/0xabc/img",
    contractVerdict: { fatal: false, unknown: false, deduction: 5, flags: [] },
  };
  const args = { chain: { key: "base", label: "Base" }, contractAddress: "0x" + "a".repeat(40), riskResult, source: "new_collection" };

  const origin = Telegram.prototype.callApi;
  let photoAttempts = 0;
  Telegram.prototype.callApi = async (method, payload) => {
    if (method === "sendPhoto") { photoAttempts++; throw new Error("400: Bad Request: failed to get HTTP URL content"); }
    return { message_id: 1, chat: { id: CHAT }, text: payload?.text };
  };

  await postNftCall(bot, args);
  assert.equal(photoAttempts, 1, "first call should try the photo");

  await postNftCall(bot, args);
  assert.equal(photoAttempts, 1, "second call must not retry a host already known to refuse");

  Telegram.prototype.callApi = origin;
});

await t("an unrelated send error does not condemn the host", async () => {
  const { postNftCall } = await import("../src/telegram/bot.js");
  const riskResult = {
    score: 50, grade: "C", label: "Medium Risk", flags: [],
    breakdown: { contractSafety: 30, marketplaceLiquidity: 0, holderDistribution: 6, deployerHistory: 10 },
    name: "Test", slug: null, stats: null, totalSupply: null,
    imageUrl: "https://images.example-ok.test/x.png",
    contractVerdict: { fatal: false, unknown: false, deduction: 5, flags: [] },
  };
  const args = { chain: { key: "base", label: "Base" }, contractAddress: "0x" + "b".repeat(40), riskResult, source: "new_collection" };

  const origin = Telegram.prototype.callApi;
  let photoAttempts = 0;
  Telegram.prototype.callApi = async (method, payload) => {
    if (method === "sendPhoto") { photoAttempts++; throw new Error("429: Too Many Requests: retry after 5"); }
    return { message_id: 1, chat: { id: CHAT }, text: payload?.text };
  };

  await postNftCall(bot, args);
  await postNftCall(bot, args);
  assert.equal(photoAttempts, 2, "a rate limit says nothing about whether the CDN serves Telegram");

  Telegram.prototype.callApi = origin;
});

await t("/nftscore is still present and unchanged", async () => {
  const out = texts(await send("/nftscore"));
  assert.ok(out.length > 0, "/nftscore must still respond");
  assert.ok(!/nftcheck/.test(out), "/nftscore must not have been merged into the scan");
});

// ── Mint configurator ───────────────────────────────────────────────────
// The controls must never offer a number the contract didn't publish, and
// the execution buttons must refuse out loud rather than doing nothing.
await t("/mint rejects a bad address and names the chains", async () => {
  const out = texts(await send("/mint notanaddress"));
  assert.match(out, /Usage: \/mint/);
  assert.match(out, /robinhood/);
});

await t("/mint refuses a chain this bot does not watch", async () => {
  const out = texts(await send("/mint mainnet 0x000000000000000000000000000000000000dEaD"));
  assert.match(out, /Unknown chain/);
});

await t("the quantity stepper clamps to the contract's max per wallet", async () => {
  const mintSession = await import("../src/mint/mintSession.js");
  const detect = {
    checked: true, name: "Test Drop", symbol: "T", standard: "seadrop",
    totalSupply: 1n, maxSupply: 100n, soldOut: false, mintable: true,
    phase: { kind: "public", priceWei: 1000000000000000n, startsAt: new Date(), endsAt: new Date(Date.now() + 3600e3), maxPerWallet: 3, feeBps: 0, live: true },
    mintVia: { target: "0x" + "1".repeat(40), signature: "mintPublic(...)", note: "n" },
    proxy: null,
  };
  mintSession.startSession(CHAT, { chain: { key: "robinhood", label: "Robinhood Chain" }, contractAddress: "0x" + "a".repeat(40), detect });

  assert.equal(mintSession.getSession(CHAT).quantity, 3, "should open at the cap");
  await tap("mint:qty:1");
  assert.equal(mintSession.getSession(CHAT).quantity, 3, "must not exceed the contract's cap");
  await tap("mint:qty:-1");
  assert.equal(mintSession.getSession(CHAT).quantity, 2);
  await tap("mint:qty:max");
  assert.equal(mintSession.getSession(CHAT).quantity, 3);
});

await t("wallet count cannot exceed the loaded roster", async () => {
  const mintSession = await import("../src/mint/mintSession.js");
  await tap("mint:wal:1");
  assert.equal(mintSession.getSession(CHAT).wallets, 0, "no wallets loaded means it cannot go above 0");
});

await t("explicit wallet selection is tracked separately from wallet count", async () => {
  const mintSession = await import("../src/mint/mintSession.js");
  const detect = {
    checked: true, name: "Test Drop", symbol: "T", standard: "seadrop",
    totalSupply: 1n, maxSupply: 100n, soldOut: false, mintable: true,
    phase: { kind: "public", priceWei: 1000000000000000n, startsAt: new Date(), endsAt: new Date(Date.now() + 3600e3), maxPerWallet: 3, feeBps: 0, live: true },
    mintVia: { target: "0x" + "1".repeat(40), signature: "mintPublic(...)", note: "n" },
    proxy: null,
  };
  const session = mintSession.startSession(CHAT, { chain: { key: "robinhood", label: "Robinhood Chain" }, contractAddress: "0x" + "b".repeat(40), detect });
  mintSession.setWalletAddresses(CHAT, ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"]);
  assert.deepEqual(mintSession.selectedWalletAddresses(session), [
    "0x1111111111111111111111111111111111111111",
    "0x2222222222222222222222222222222222222222",
  ]);
  assert.equal(mintSession.effectiveWalletCount(session), 2);
  mintSession.setWalletCount(CHAT, 1);
  assert.equal(mintSession.selectedWalletAddresses(mintSession.getSession(CHAT)), null, "switching back to count mode should clear the explicit selection");
  assert.equal(mintSession.getSession(CHAT).wallets, 0);
});

await t("a price override is applied, then clearable back to the contract price", async () => {
  const mintSession = await import("../src/mint/mintSession.js");
  await tap("mint:px:1000000000000000");
  assert.equal(mintSession.getSession(CHAT).priceOverrideWei, 2000000000000000n);
  await tap("mint:px:clear");
  assert.equal(mintSession.getSession(CHAT).priceOverrideWei, null, "cleared means null, not a number that happens to match");
});

await t("a price override can never go negative", async () => {
  const mintSession = await import("../src/mint/mintSession.js");
  for (let i = 0; i < 5; i++) await tap("mint:px:-10000000000000000");
  assert.ok(mintSession.getSession(CHAT).priceOverrideWei >= 0n);
});

// CONFIRM is wired to the executor now. With execution disabled — the
// default — it must refuse and must never imply a transaction went out.
// Caps of 60+ make a stepper unusable, so quantity can be typed. Clamping
// rather than rejecting matters: someone typing 100 against a cap of 60 wants
// the most they can have.
await t("a typed quantity is applied, and clamped to the cap", async () => {
  const mintSession = await import("../src/mint/mintSession.js");
  await tap("mint:qty:type");
  await send("2");
  assert.equal(mintSession.getSession(CHAT).quantity, 2, "typed value should apply");

  await tap("mint:qty:type");
  await send("999");
  assert.equal(mintSession.getSession(CHAT).quantity, 3, "must clamp to the contract's cap, not reject");
});

await t("a typed quantity rejects nonsense without changing anything", async () => {
  const mintSession = await import("../src/mint/mintSession.js");
  const before = mintSession.getSession(CHAT).quantity;
  await tap("mint:qty:type");
  const out = texts(await send("abc"));
  assert.match(out, /whole number/i);
  assert.equal(mintSession.getSession(CHAT).quantity, before, "a bad entry must leave the config alone");
});

await t("CONFIRM MINT refuses while execution is disabled, and says so", async () => {
  const { loadMintExecutionSettings, saveMintExecutionSettings } = await import("../src/mint/mintExecutionSettings.js");
  saveMintExecutionSettings({ ...loadMintExecutionSettings(), enabled: false });

  const out = texts(await tap("mint:confirm"));
  assert.match(out, /disabled/i, "must name the reason");
  assert.ok(!/(sent|submitted|broadcast|0x[a-f0-9]{64})/i.test(out), `must not imply a send:
${out}`);
});

await t("the config text surfaces blockers above the buttons", async () => {
  const { buildMintConfigText } = await import("../src/telegram/mintKeyboard.js");
  const mintSession = await import("../src/mint/mintSession.js");
  const c = mintSession.getSession(CHAT);
  const text = buildMintConfigText({ ...c, detect: { ...c.detect, soldOut: true } });
  assert.match(text, /Can't mint:.*sold out/);
});

await t("the config text can surface eligible wallets inline", async () => {
  const { buildMintConfigText } = await import("../src/telegram/mintKeyboard.js");
  const mintSession = await import("../src/mint/mintSession.js");
  const c = mintSession.getSession(CHAT);
  const text = buildMintConfigText({
    ...c,
    walletEligibility: [
      { address: "0x1111111111111111111111111111111111111111", balance: 1000000000000000n, minted: 0, remaining: 3, funded: true, ok: true, reason: null },
      { address: "0x2222222222222222222222222222222222222222", balance: 0n, minted: 0, remaining: 3, funded: false, ok: false, reason: "insufficient funds" },
    ],
  });
  assert.match(text, /Eligible wallets/);
  assert.match(text, /0x11111111/);
  assert.match(text, /insufficient funds/);
});

try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

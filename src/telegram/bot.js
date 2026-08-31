import { Telegraf, Markup } from "telegraf";
import { Wallet, formatEther} from "ethers";
import { config } from "../config.js";
import { CHAINS } from "../chains.js";
import { isPaused, setPaused, isNftNotificationsEnabled, setNftNotificationsEnabled, isCallsChannelEnabled, setCallsChannelEnabled } from "../botState.js";
// dexscreener is the one module left over from the token side that the NFT
// bot genuinely needs: it is the only USD reference available for a native
// balance, and mint/nativePrice.js reads it for the same reason.
import { getBestPair, pairSummary } from "../risk/dexscreener.js";
import {
  recordBotUser,
  countBotUsers,
  getWatchedWallets,
  addWatchedWallet,
  removeWatchedWallet,
  getAllWalletTrackRecords,
  getNftPaperTradingStats,
  getNftRealTradingStats,
  getOpenNftPaperTrades,
  getOpenNftRealTrades,
} from "../store/db.js";
import { hasWallet, getWalletAddress, getNativeBalance, resolveEnsName, getPrivateKeyForExport, getProvider } from "../wallet.js";
import { saveWalletPrivateKey } from "../walletSettings.js";
import { computeNftRiskScore } from "../risk/nftRisk.js";
import { detectNftDangerousFunctions, assessNftContractRisk } from "../risk/nftDangerousFunctions.js";
import { buildNftScanMessage } from "./formatNftScan.js";
import { detectNftMint } from "../mint/nftMintDetect.js";
import { buildMintDetectMessage } from "./formatMintDetect.js";
import { buildMintConfigText, mintConfigKeyboard, mintCardExtra, buildMintResultText, mintResultKeyboard } from "./mintKeyboard.js";
import * as mintSession from "../mint/mintSession.js";
import { handlePastedTarget, loadCardExtras, loadRoundTrip } from "./handlePaste.js";
import { executeMint, findMaxMintable, checkWalletEligibility } from "../mint/nftMintExecutor.js";
import { buyNftCollectionFloor, listNftForSale } from "../execution/nftExecutor.js";
import { confirmMint } from "../mint/mintResult.js";
import { loadHoldings, priceHoldings, recordAcquisition } from "../mint/nftHoldings.js";
import { buildHoldingsText, holdingsKeyboard, holdingsExtra } from "./formatHoldings.js";
import { armMint, disarmMint, listArmedMints } from "../mint/mintScheduler.js";
import { loadMintExecutionSettings, saveMintExecutionSettings } from "../mint/mintExecutionSettings.js";
import { listMintWallets, countMintWallets, importMintWallets, removeMintWallet, signerForMintWallet } from "../mint/mintWallets.js";
import { getContract } from "../risk/opensea.js";
import { getNftChainKeys, getNftChainDefs } from "../nftChains.js";
import { loadNftFilters, saveNftFilters } from "../filters/nftFilter.js";
import { loadNftPaperTradingSettings, saveNftPaperTradingSettings } from "../nftPaperTradingSettings.js";
import { loadNftRealTradingSettings, saveNftRealTradingSettings } from "../nftRealTradingSettings.js";
import {
  buildNftCallMessage,
  buildNftTradingSummary,
  fmtUsd,
  escapeMd,
} from "./formatMessage.js";

const ADDRESS_RE = /0x[a-fA-F0-9]{40}/;
const ENS_RE = /^[a-z0-9-]+(\.[a-z0-9-]+)*\.eth$/i;
const PENDING_TTL_MS = 5 * 60 * 1000;

// Accepts either a raw 0x address or an ENS .eth name — shared by every
// "add a watched wallet" entry point (the Add Wallet button flow and the
// /watchwallet command) so both take the same input formats. Returns null
// if the input is neither a valid address nor a resolvable ENS name. When
// resolved from a name, that name is returned as the suggested label —
// nicer than a truncated hex address in the Watched Wallets list, and the
// caller only overrides it if the user typed an explicit label too.
async function resolveWalletAddressInput(input) {
  if (ADDRESS_RE.test(input)) return { address: input, label: null };
  if (ENS_RE.test(input)) {
    const resolved = await resolveEnsName(input);
    if (!resolved) return null;
    return { address: resolved, label: input };
  }
  return null;
}

// Tracks "what is this chat's next plain-text message for" after a button
// prompt (e.g. "paste an address to track"), so free text can be routed
// without slash commands. Expires so a stale prompt doesn't hijack an
// unrelated later message.
const pendingAction = new Map();
function setPending(chatId, action) {
  pendingAction.set(chatId, { ...action, expiresAt: Date.now() + PENDING_TTL_MS });
}
function takePending(chatId) {
  const p = pendingAction.get(chatId);
  pendingAction.delete(chatId);
  if (!p || Date.now() > p.expiresAt) return null;
  return p;
}

function isAdmin(ctx) {
  if (!config.telegram.adminUserId) return true; // no admin configured — allow anyone (private bot use)
  return String(ctx.from?.id) === config.telegram.adminUserId;
}

// Passcode lock on the wallet menu — separate from isAdmin(), which only
// checks *who* you are. This additionally requires proving you know the
// passcode, and re-locks after a period of inactivity so an unattended,
// already-authenticated session doesn't stay unlocked forever.
//
// Survived the token-trading prune because what it guards did not go away:
// behind this menu sit "reveal the private key" and "replace the key", and a
// Telegram session left open on an unlocked phone is exactly the threat it
// was written for. The env var stays REAL_TRADING_PASSCODE — renaming it
// would silently unlock every existing install on the next boot, which is the
// opposite of what a security gate should do on upgrade.
const WALLET_UNLOCK_TTL_MS = 30 * 60 * 1000;
const walletUnlockedUntil = new Map(); // chatId -> expiry timestamp

function isWalletUnlocked(chatId) {
  const exp = walletUnlockedUntil.get(chatId);
  return Boolean(exp && Date.now() < exp);
}

function unlockWallet(chatId) {
  walletUnlockedUntil.set(chatId, Date.now() + WALLET_UNLOCK_TTL_MS);
}

// Gate for every wallet-menu handler, not just the menu entry point —
// callback data can in principle be replayed/guessed, so each handler
// re-checks rather than trusting that reaching it means the menu was seen.
// Returns true if the caller may proceed.
async function requireWalletUnlock(ctx) {
  if (!config.realTradingPasscode) {
    // Branch on the update kind, not on the method existing. Context always
    // defines answerCbQuery and throws when the update is a message — and the
    // message path is exactly how a private key arrives, so the optional call
    // threw out of the import handler instead of explaining the lockout.
    // Same defect as requireOpensea had.
    if (ctx.callbackQuery) await ctx.answerCbQuery("Wallet setup is not configured.");
    await ctx.reply("⚠️ Wallet setup is locked out — no REAL_TRADING_PASSCODE is set in .env.");
    return false;
  }
  if (!isWalletUnlocked(ctx.chat.id)) {
    await ctx.answerCbQuery?.("Locked — enter the passcode.");
    setPending(ctx.chat.id, { type: "walletPasscode" });
    await ctx.reply("🔒 Wallet setup is locked. Send the passcode to continue.");
    return false;
  }
  return true;
}

function mainMenuKeyboard() {
  const exec = loadMintExecutionSettings();
  const wallets = countMintWallets();
  // Mint-bot navigation only. The token-trading menus this repo was seeded
  // from are gone from here: they belong to a different bot, and leaving
  // them on the home screen invites using them.
  return Markup.inlineKeyboard([
    [Markup.button.callback(`💼 Mint wallets (${wallets})`, "menu:mintwallets")],
    [Markup.button.callback("🖼 My NFTs", "menu:holdings")],
    [Markup.button.callback(`${exec.enabled ? "🟢 Minting: ENABLED" : "⚪️ Minting: off"}`, "menu:mintsettings")],
    [Markup.button.callback("⏰ Armed mints", "menu:armed")],
    [Markup.button.callback("🛡 Contract scan", "menu:nftcheck")],
    [Markup.button.callback("📊 Status", "menu:status")],
  ]);
}


function nftMenuKeyboard() {
  const notifsOn = isNftNotificationsEnabled();
  return Markup.inlineKeyboard([
    [Markup.button.callback("⚙️ NFT Filter", "menu:nftfilter"), Markup.button.callback("👛 Watched Wallets", "menu:nftwallets")],
    [Markup.button.callback("📈 NFT Paper Trading", "menu:nftpapertrading")],
    [Markup.button.callback("💰 NFT Real Trading", "menu:nftrealtrading")],
    [Markup.button.callback("🔍 Score Collection", "menu:nftscore"),
     Markup.button.callback("🛡 Contract Scan", "menu:nftcheck")],
    [Markup.button.callback(notifsOn ? "🔔 Notifications: ON (tap to mute)" : "🔕 Notifications: OFF (tap to unmute)", "menu:nfttogglenotifications")],
    [Markup.button.callback("🔙 Menu", "menu:home")],
  ]);
}

// Groups the filter list by what each setting actually gates, because the
// flat key list gives no clue that half of them are inert on a brand-new
// collection. The source-awareness is real behaviour in nftFilter.js — floor,
// volume and ownership checks are skipped for `new_collection` calls, since a
// collection still minting has no market to measure — and someone tuning
// these on a phone should not have to read the filter source to discover it.
function renderNftFiltersText(filters) {
  return [
    "⚙️ *NFT Filter Settings*",
    "",
    `*Contract gate* — runs on every call, mint or secondary:`,
    `  • Hard gate on fatal capability: ${filters.blockFatalContract ? "on" : "OFF"}`,
    `  • Reject unreadable contracts: ${filters.blockUnknownContract ? "on" : "OFF"}`,
    `  • Minimum risk score: ${filters.minRiskScore}`,
    "",
    `*Market gate* — skipped for brand-new collections, which have no market yet:`,
    `  • Floor ${filters.minFloorPriceEth}–${filters.maxFloorPriceEth} ETH, 24h vol ≥ ${filters.minVolume24hEth} ETH`,
    `  • Owners ≥ ${filters.minOwnerCount}, concentration ≤ ${filters.maxOwnerConcentrationPercent}%`,
    "",
    "Tap a setting to change it:",
  ].join("\n");
}

function nftFilterKeyboard(filters) {
  // Booleans get a one-tap toggle rather than the type-a-value prompt the
  // numeric settings use. The generic prompt path does parse "true"/"false"
  // correctly, but making someone type the word `false` to disarm a safety
  // gate — on a phone, possibly in a hurry — is the kind of friction that
  // gets a gate left in the wrong state.
  const rows = Object.entries(filters).map(([k, v]) =>
    typeof v === "boolean"
      ? [Markup.button.callback(`${v ? "✅" : "⬜️"} ${k}`, `nftfiltertoggle:${k}`)]
      : [Markup.button.callback(`${k}: ${v}`, `nftfilteredit:${k}`)]
  );
  rows.push([Markup.button.callback("🔙 NFTs", "menu:nft")]);
  return Markup.inlineKeyboard(rows);
}

// Fits comfortably under Telegram's message/keyboard limits even with a
// real bulk-imported wallet list (this bot has had 95+ wallets loaded at
// once) — each row needs both a text line and its own remove button, so
// this stays well under a page (20), which only needs page-nav
// buttons, not one button per entry.
const WALLETS_PAGE_SIZE = 12;

// Sorts every watched wallet by its copy-trade track record (best average
// return first — see nftOutcomeTracker.js/getAllWalletTrackRecords) and
// slices to one page. Text and keyboard are built from the same slice so
// a remove button always matches the row next to it, even mid-pagination.
function pageWatchedWallets(wallets, offset) {
  const records = getAllWalletTrackRecords();
  const withRecords = wallets.map((w) => ({ wallet: w, record: records.get(w.address) || { signals: 0, avgPct: null, winRate: null } }));
  withRecords.sort((a, b) => (b.record.avgPct ?? -Infinity) - (a.record.avgPct ?? -Infinity));
  return { shown: withRecords.slice(offset, offset + WALLETS_PAGE_SIZE), total: wallets.length };
}

// "Copy-trading intelligence" — each wallet's track record, not just its
// label. A signal is only resolved 24h after the call (nftOutcomeTracker.js),
// so a freshly-added wallet has no data yet; shown as such rather than a
// misleading "0% win rate."
function renderWatchedWalletsText(shown, total, offset) {
  if (total === 0) {
    return "👛 *Watched Wallets*\n\nNone yet — tap Add Wallet to start copy-trading a wallet's NFT buys.";
  }
  const lines = shown.map(({ wallet: w, record }) => {
    const label = escapeMd(w.label) || `\`${w.address.slice(0, 10)}…\``;
    if (record.signals === 0) return `⚪️ ${label} — no resolved signals yet`;
    const winRatePct = record.winRate * 100;
    const dot = winRatePct >= 50 ? "🟢" : "🔴";
    const avgLabel = record.avgPct >= 0 ? `+${record.avgPct.toFixed(1)}%` : `${record.avgPct.toFixed(1)}%`;
    return `${dot} ${label} — ${record.signals} signal${record.signals === 1 ? "" : "s"} · ${winRatePct.toFixed(0)}% win · avg ${avgLabel}`;
  });
  const rangeLabel = total > WALLETS_PAGE_SIZE ? ` — showing ${offset + 1}-${offset + shown.length}, sorted by track record` : "";

  return [
    `👛 *Watched Wallets* (${total})${rangeLabel}`,
    "",
    "Copy-trade signals fire when one of these buys an NFT. Track record = how the collection's floor moved 24h after each past signal.",
    "",
    lines.join("\n"),
  ].join("\n");
}

function nftWalletsKeyboard(shown, total, offset) {
  const rows = shown.map(({ wallet: w }) => [Markup.button.callback(`🗑 ${w.label || w.address.slice(0, 10) + "…"}`, `nftwalletremove:${w.address}:${offset}`)]);
  const navRow = [];
  if (offset > 0) navRow.push(Markup.button.callback("⬅️ Previous", `nftwalletspage:${Math.max(0, offset - WALLETS_PAGE_SIZE)}`));
  if (offset + WALLETS_PAGE_SIZE < total) navRow.push(Markup.button.callback("➡️ Show More", `nftwalletspage:${offset + WALLETS_PAGE_SIZE}`));
  if (navRow.length) rows.push(navRow);
  rows.push([Markup.button.callback("➕ Add Wallet", "nftwalletadd")]);
  rows.push([Markup.button.callback("🔙 NFTs", "menu:nft")]);
  return Markup.inlineKeyboard(rows);
}

function nftPaperTradingKeyboard(settings) {
  return Markup.inlineKeyboard([
    [Markup.button.callback(settings.enabled ? "⏸ Pause" : "▶️ Resume", "nftpapertoggle")],
    [Markup.button.callback(`Budget: ${settings.totalBudgetEth} ETH`, "nftpaperedit:totalBudgetEth")],
    [Markup.button.callback(`Position size: ${settings.positionSizeEth} ETH`, "nftpaperedit:positionSizeEth")],
    [Markup.button.callback(`Target: ${settings.targetMultiple}x floor`, "nftpaperedit:targetMultiple")],
    [Markup.button.callback(`Stop: ${settings.stopFloorPct}% of entry`, "nftpaperedit:stopFloorPct")],
    [Markup.button.callback("📋 Active Positions", "menu:nftpaperactive")],
    [Markup.button.callback("🔄 Refresh", "menu:nftpapertrading"), Markup.button.callback("🔙 NFTs", "menu:nft")],
  ]);
}

function nftRealTradingKeyboard(settings, walletReady) {
  const toggleAction = settings.enabled ? "nftrealtoggle" : "nftrealconfirm:enable";
  const rows = [
    [Markup.button.callback(settings.enabled ? "⏸ Pause (real money)" : "▶️ Enable REAL NFT trading", toggleAction)],
    [Markup.button.callback(`Budget: ${settings.totalBudgetEth} ETH`, "nftrealedit:totalBudgetEth")],
    [Markup.button.callback(`Position size: ${settings.positionSizeEth} ETH`, "nftrealedit:positionSizeEth")],
    [Markup.button.callback(`Target: ${settings.targetMultiple}x floor`, "nftrealedit:targetMultiple")],
    [Markup.button.callback(`Stop: ${settings.stopFloorPct}% of entry`, "nftrealedit:stopFloorPct")],
    [Markup.button.callback("📋 Active Positions", "menu:nftrealactive")],
    [Markup.button.callback("🔄 Refresh", "menu:nftrealtrading"), Markup.button.callback("🔙 NFTs", "menu:nft")],
  ];
  if (!walletReady) rows.unshift([Markup.button.callback("⚠️ No wallet configured — see .env", "menu:nftrealtrading")]);
  return Markup.inlineKeyboard(rows);
}

function nftRealEnableConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Yes, trade NFTs with REAL money", "nftrealtoggle")],
    [Markup.button.callback("❌ Cancel", "menu:nftrealtrading")],
  ]);
}

// One copy of the wallet blurb: the menu action and the just-unlocked reply
// both render it, and two copies of a warning about overwriting a key is one
// copy too many.
function renderWalletSetupText(address) {
  return address
    ? `🔑 *Wallet Setup*\n\nCurrent wallet:\n\`${address}\`\n\nCreating or importing a new key replaces this — it does NOT move existing funds. Withdraw first if this wallet holds anything you want to keep.`
    : `🔑 *Wallet Setup*\n\nNo wallet configured yet.`;
}

function walletMenuKeyboard(hasWalletConfigured) {
  const rows = [
    [Markup.button.callback(hasWalletConfigured ? "🆕 Replace with new wallet" : "🆕 Create new wallet", "walletcreateconfirm")],
    [Markup.button.callback("📥 Import private key", "walletimportconfirm")],
  ];
  if (hasWalletConfigured) {
    rows.push([Markup.button.callback("👁 Reveal private key", "walletreveal")]);
  }
  rows.push([Markup.button.callback("🔙 Menu", "menu:home")]);
  return Markup.inlineKeyboard(rows);
}

function walletCreateConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Yes, create a new wallet", "walletcreate")],
    [Markup.button.callback("❌ Cancel", "menu:wallet")],
  ]);
}

function walletImportConfirmKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("✅ Yes, I have a private key ready", "walletimportstart")],
    [Markup.button.callback("❌ Cancel", "menu:wallet")],
  ]);
}

function backKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("🔙 Menu", "menu:home")]]);
}

function refreshKeyboard(action) {
  return Markup.inlineKeyboard([[Markup.button.callback("🔄 Refresh", action), Markup.button.callback("🔙 Menu", "menu:home")]]);
}

function welcomeText() {
  const wallets = countMintWallets();
  const exec = loadMintExecutionSettings();
  const armed = listArmedMints().length;
  return [
    "⚡️ *NFT Mint Underwriter*",
    "",
    "*Paste a contract address or a mint link.* That's it — no command.",
    "It reads the drop straight off the chain and hands you the controls.",
    "",
    "*What you get back:*",
    "• price, phase open/close, max per wallet, how many are left",
    "• which contract the mint actually goes to (SeaDrop mints do NOT go to the collection)",
    "• quantity / wallets / price controls, then MINT or SWEEP",
    "• ⏰ arm a drop that hasn't opened — it prepares early and fires at the open",
    "",
    "*Right now:*",
    `• Wallets loaded: *${wallets}*`,
    `• Minting: *${exec.enabled ? "🟢 ENABLED — this bot can spend" : "⚪️ off"}*`,
    `• Spend ceiling: ${exec.maxSpendEthPerRun} ETH per run`,
    ...(armed ? [`• Armed: *${armed}* waiting to fire`] : []),
    "",
    "No OpenSea or explorer on the critical path — it answers for a contract",
    "deployed sixty seconds ago.",
  ].join("\n");
}

// Counts what this bot actually does. It used to report tokens seen/called/
// pending, which after the token prune were three permanently-zero rows —
// worse than useless on a status screen, because a zero reads as "nothing is
// working" rather than "nothing is being counted".
function renderStatusText(stats) {
  return [
    "📊 *Status*",
    "",
    `Bot: ${isPaused() ? "⏸ PAUSED (not scoring or minting)" : "🟢 running"}`,
    `Chains: ${getNftChainDefs().map((c) => c.label).join(", ") || "none"}`,
    `Collections called: ${stats.nftCalled}`,
    `Mint wallets: ${countMintWallets()}`,
    `Armed mints: ${listArmedMints().length}`,
    `Uptime: ${Math.floor(process.uptime() / 60)}m`,
  ].join("\n");
}

async function safeEdit(ctx, text, keyboard, extra = {}) {
  try {
    await ctx.editMessageText(text, { parse_mode: "Markdown", ...extra, ...keyboard });
  } catch (err) {
    if (!/message is not modified/i.test(err.description || err.message || "")) {
      console.error("editMessageText failed:", err.message);
    }
  }
}

// Resolves which active NFT chain a pasted contract address belongs to —
// same "try each configured chain" idea as the token side's detectChains,
// just via OpenSea's own contract lookup instead of DexScreener search
// (there's no NFT-equivalent multi-chain search endpoint to call once).
async function detectNftChain(contractAddress) {
  const chains = getNftChainDefs();
  for (const chain of chains) {
    const info = await getContract(chain.key, contractAddress).catch(() => null);
    if (info?.slug) return chain;
  }
  return null;
}

async function scoreAndReplyNft(ctx, contractAddress, chainKeyHint) {
  let chain;
  if (chainKeyHint) {
    if (!CHAINS[chainKeyHint]) throw new Error(`Unknown chain. Options: ${getNftChainKeys().join(", ")}`);
    chain = { key: chainKeyHint, ...CHAINS[chainKeyHint] };
  } else {
    chain = await detectNftChain(contractAddress);
    if (!chain) throw new Error(`Couldn't find this collection on any watched NFT chain (${getNftChainKeys().join(", ")}).`);
  }
  const riskResult = await computeNftRiskScore(chain, contractAddress);
  const message = buildNftCallMessage({ chain, contractAddress, riskResult, source: "new_collection" });
  await ctx.reply(message, { parse_mode: "Markdown", ...backKeyboard() });
}

// Pure bytecode + storage scan. Deliberately does NOT go through
// detectNftChain: that resolves the collection via OpenSea and throws when
// OpenSea hasn't indexed it, which is exactly the case this exists to
// cover. Chain is explicit or defaults to the first enabled NFT chain.
//
// No OPENSEA_API_KEY gate either, for the same reason — this path has no
// OpenSea dependency, so requiring the key would block the one check that
// still works without it.
async function scanAndReplyNftContract(ctx, contractAddress, chainKeyHint) {
  // Validate against the ENABLED NFT chains, not CHAINS. CHAINS also holds
  // the token-only chains, so checking it accepted `/nftcheck ethereum ...`
  // and then failed several layers down with "No RPC configured for
  // ethereum (ETHEREUM_HTTP_RPC)" — an internal plumbing message for what is
  // really "this bot doesn't watch that chain".
  const chainKey = chainKeyHint || getNftChainKeys()[0];
  if (!getNftChainKeys().includes(chainKey) || !CHAINS[chainKey]) {
    throw new Error(`Unknown chain. Options: ${getNftChainKeys().join(", ")}`);
  }
  const chain = { key: chainKey, ...CHAINS[chainKey] };

  const startedAt = Date.now();
  const scan = await detectNftDangerousFunctions(chain, contractAddress, { budgetMs: 8000 });
  const elapsedMs = Date.now() - startedAt;
  const verdict = assessNftContractRisk(scan);

  const message = buildNftScanMessage({ chain, contractAddress, scan, verdict, elapsedMs });
  await ctx.reply(message, { parse_mode: "Markdown", ...backKeyboard() });
}

async function handlePendingAction(ctx, pending, text) {
  // pendingAction is keyed by chat, not by user — in a group chat, anyone
  // could otherwise win the race to answer a prompt the admin armed (e.g. a
  // filter edit or a manual buy amount) before the admin replies themselves.
  // Every button that sets a pending action already checks isAdmin(ctx), so
  // re-checking here just makes the free-text continuation match that.
  if (!isAdmin(ctx)) {
    return ctx.reply("Not authorized.");
  }
  if (pending.type === "walletPasscode") {
    if (!config.realTradingPasscode) {
      return ctx.reply("⚠️ Wallet setup is locked out — no REAL_TRADING_PASSCODE is set in .env.");
    }
    if (text.trim() !== config.realTradingPasscode) {
      return ctx.reply("❌ Wrong passcode.");
    }
    // Scrub the passcode from the chat for the same reason the private-key
    // import below scrubs the key: it is a secret, and it would otherwise sit
    // in scrollback forever.
    await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    unlockWallet(ctx.chat.id);
    const address = getWalletAddress();
    return ctx.reply(renderWalletSetupText(address), { parse_mode: "Markdown", ...walletMenuKeyboard(Boolean(address)) });
  }

  if (pending.type === "nftFilter") {
    const filters = loadNftFilters();
    const prev = filters[pending.key];
    const nextValue = typeof prev === "boolean" ? text.trim().toLowerCase() === "true" : Number(text.trim());
    if (typeof prev === "number" && Number.isNaN(nextValue)) {
      return ctx.reply("That doesn't look like a valid number — tap the setting again to retry.");
    }
    filters[pending.key] = nextValue;
    saveNftFilters(filters);
    return ctx.reply(`Updated *${pending.key}*: ${prev} → ${nextValue}`, { parse_mode: "Markdown", ...backKeyboard() });
  }

  if (pending.type === "nftWalletAdd") {
    const [rawInput, ...labelParts] = text.trim().split(/\s+/);
    const resolved = await resolveWalletAddressInput(rawInput);
    if (!resolved) {
      return ctx.reply("That doesn't look like a valid wallet address or resolvable ENS name — tap Add Wallet again to retry.");
    }
    const label = labelParts.join(" ") || resolved.label;
    addWatchedWallet(resolved.address, label);
    const { shown, total } = pageWatchedWallets(getWatchedWallets(), 0);
    return ctx.reply(`👛 Now watching \`${resolved.address}\`${label ? ` (${escapeMd(label)})` : ""}`, {
      parse_mode: "Markdown",
      ...nftWalletsKeyboard(shown, total, 0),
    });
  }

  if (pending.type === "nftPaperTrading") {
    const value = Number(text.trim());
    if (!Number.isFinite(value)) {
      return ctx.reply("That doesn't look like a valid number — tap the setting again to retry.");
    }
    const settings = loadNftPaperTradingSettings();
    const prev = settings[pending.key];
    settings[pending.key] = value;
    saveNftPaperTradingSettings(settings);
    return ctx.reply(`Updated *${pending.key}*: ${prev} → ${value}`, { parse_mode: "Markdown", ...backKeyboard() });
  }

  if (pending.type === "nftRealTrading") {
    if (!(await requireWalletUnlock(ctx))) return;
    const value = Number(text.trim());
    if (!Number.isFinite(value)) {
      return ctx.reply("That doesn't look like a valid number — tap the setting again to retry.");
    }
    const settings = loadNftRealTradingSettings();
    const prev = settings[pending.key];
    settings[pending.key] = value;
    saveNftRealTradingSettings(settings);
    let note = "";
    if (pending.key === "positionSizeEth" && value > 0.15) {
      note = "\n⚠️ Buys execute a hard-coded 0.15 ETH/item safety ceiling regardless of this setting — this value won't actually be used above that.";
    }
    return ctx.reply(`Updated *${pending.key}*: ${prev} → ${value}${note}`, { parse_mode: "Markdown", ...backKeyboard() });
  }

  if (pending.type === "nftScore") {
    const contractAddress = text.trim();
    if (!ADDRESS_RE.test(contractAddress)) {
      return ctx.reply("That doesn't look like a valid contract address.");
    }
    await ctx.reply("Analyzing…");
    try {
      await scoreAndReplyNft(ctx, contractAddress);
    } catch (err) {
      return ctx.reply(`Failed to score collection: ${err.message}`);
    }
    return;
  }

  if (pending.type === "nftCheck") {
    const contractAddress = text.trim();
    if (!ADDRESS_RE.test(contractAddress)) {
      return ctx.reply("That doesn't look like a valid contract address.");
    }
    await ctx.reply("Reading contract…");
    try {
      await scanAndReplyNftContract(ctx, contractAddress);
    } catch (err) {
      return ctx.reply(`Scan failed: ${err.message}`);
    }
    return;
  }

  if (pending.type === "mintQuantity" || pending.type === "mintWalletCount") {
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");

    const n = Number(text.trim());
    if (!Number.isInteger(n) || n < 1) {
      return ctx.reply("Send a whole number of 1 or more — tap ⌨️ again to retry.");
    }

    // Clamp rather than reject. Someone typing 100 against a cap of 60 wants
    // the most they can have, and refusing on a technicality sends them back
    // to look up a number the bot already knows.
    const ceiling =
      pending.type === "mintQuantity" ? config.detect.phase?.maxPerWallet ?? n : countMintWallets();
    const applied = Math.min(n, ceiling);

    if (pending.type === "mintQuantity") mintSession.setQuantity(ctx.chat.id, applied);
    else mintSession.setWalletCount(ctx.chat.id, applied);

    const updated = mintSession.getSession(ctx.chat.id);
    if (applied < n) {
      await ctx.reply(`${n} is above the maximum of ${ceiling} — using ${applied}.`);
    }
    return ctx.reply(buildMintConfigText(updated), { ...mintCardExtra(updated), ...mintConfigKeyboard(updated) });
  }

  if (pending.type === "mintWalletImport") {
    // Scrub before parsing, exactly like walletImportKey below: the key should
    // not linger in chat history whether or not it turned out to be valid.
    await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    const results = importMintWallets(text);
    const ok = results.filter((r) => r.ok);
    const bad = results.filter((r) => !r.ok);
    const lines = [`✅ Imported ${ok.length} wallet(s).`];
    for (const r of ok) lines.push(`  \`${r.address}\``);
    // Rejections are reported by line number, never by content — echoing a
    // rejected line back could put a real key into chat history after the
    // original message was already deleted.
    for (const r of bad) lines.push(`  ⚠️ line ${r.line}: ${r.reason}`);
    lines.push("", `Roster now holds ${countMintWallets()} wallet(s).`);
    return ctx.reply(lines.join("\n"), { parse_mode: "Markdown", ...backKeyboard() });
  }

  if (pending.type === "mintWalletRemove") {
    const removed = removeMintWallet(text.trim());
    return ctx.reply(
      removed ? `Removed. Roster now holds ${countMintWallets()} wallet(s).` : "No wallet with that address in the roster.",
      { ...backKeyboard() }
    );
  }

  if (pending.type === "walletImportKey") {
    if (!(await requireWalletUnlock(ctx))) return;
    const rawKey = text.trim();
    // Scrub the raw key from chat history immediately, whether or not it
    // turns out to be valid — it shouldn't linger either way.
    await ctx.deleteMessage(ctx.message.message_id).catch(() => {});
    let wallet;
    try {
      wallet = new Wallet(rawKey);
    } catch {
      return ctx.reply("That doesn't look like a valid private key — tap Import private key again to retry.");
    }
    saveWalletPrivateKey(wallet.privateKey);
    return ctx.reply(`✅ *Wallet imported*\n\n\`${wallet.address}\``, { parse_mode: "Markdown", ...backKeyboard() });
  }
}

export function createBot(stats) {
  const bot = new Telegraf(config.telegram.botToken);

  // Without this, an error thrown by any single handler (e.g. answering an
  // expired callback query) is unhandled and takes the whole bot process
  // down. One bad button tap should never kill the bot.
  bot.catch((err, ctx) => {
    console.error(`Bot handler error (update ${ctx.updateType}):`, err.message);
  });

  // The command list is registered by scripts/setupBotFather.mjs and is NOT
  // overwritten here. This used to set a single /start entry on every boot,
  // which silently wiped the real list minutes after it was published.

  // Bot-wide access gate — drops the update before any handler (including
  // /start) ever sees it, rather than relying solely on the per-action
  // isAdmin() checks below. Deliberately chat-agnostic: any broadcast-only
  // destination (the calls-only group, a TELEGRAM_SIGNAL_CHANNELS mirror, or
  // any other group the bot ends up in) must stay a pure announcement feed,
  // and a non-admin can't route around that by DMing the bot directly
  // either — so the one rule that covers all of it is simply "only the
  // admin gets any interactive response, anywhere". No adminUserId
  // configured falls back to allowing everyone, same as isAdmin() below,
  // for solo/private use where that's never been set.
  bot.use((ctx, next) => {
    if (config.telegram.adminUserId && String(ctx.from?.id) !== config.telegram.adminUserId) return;
    return next();
  });

  // Records every distinct user who's interacted with the bot at all — not
  // just /start — so the Bot Stats count reflects actual usage.
  bot.use((ctx, next) => {
    if (ctx.from?.id) recordBotUser(ctx.from.id);
    return next();
  });

  // Gate for every entry point that needs OpenSea. answerCbQuery is only
  // valid for a callback_query update: the optional call reads as if it
  // guards that, but Context always defines the method and throws when the
  // update is a message — so every /nftscore issued without an
  // OPENSEA_API_KEY threw out of the command handler instead of replying with
  // the reason. Branch on the update kind, not on the method existing.
  function requireOpensea(ctx) {
    if (config.openseaApiKey) return true;
    if (ctx.callbackQuery) ctx.answerCbQuery("NFT features need OPENSEA_API_KEY set in .env.");
    return false;
  }

  bot.command("start", (ctx) => ctx.reply(welcomeText(), { parse_mode: "Markdown", ...mainMenuKeyboard() }));

  // Read-only utility for wiring up a new broadcast destination (e.g. a
  // channel/group meant to receive only calls) — Telegram gives no other way
  // to learn a group's chat ID short of a third-party bot, several of which
  // Telegram no longer allows into groups at all.
  bot.command("chatid", (ctx) => ctx.reply(`Chat ID: \`${ctx.chat.id}\`\nType: ${ctx.chat.type}`, { parse_mode: "Markdown" }));

  bot.action("menu:botstats", async (ctx) => {
    await ctx.answerCbQuery();
    const count = countBotUsers();
    await safeEdit(ctx, `📊 *Bot Stats*\n\nUsers who've interacted with this bot: *${count}*`, backKeyboard());
  });

  // Mainnet WETH/USD via DexScreener — one of the most liquid pairs in
  // crypto, always live regardless of this bot's own activity. A chain's
  // bridged "ETH" gas token tracks real ETH closely, so this is a far more
  // reliable USD reference than anything specific to a low-volume chain.
  const MAINNET_WETH = "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2";

  // No dedicated price oracle. There used to be a second source here that
  // derived the native price from a recently-called token's live pair; it
  // went with the token prune, and nothing was lost — it only ever fired for
  // non-ETH gas tokens, and every chain this bot mints on (Base, Robinhood)
  // pays gas in bridged ETH. A null return is handled by the caller, which
  // simply omits the USD column.
  async function getChainNativeUsdPrice(chain) {
    if (chain.nativeSymbol !== "ETH") return null;
    const dexPair = await getBestPair("ethereum", MAINNET_WETH).catch(() => null);
    const pair = pairSummary(dexPair, MAINNET_WETH);
    return pair?.priceUsd ?? null;
  }

  async function renderWalletBalance(ctx) {
    const walletAddress = getWalletAddress();
    if (!walletAddress) {
      return safeEdit(ctx, "💳 *Wallet Balance*\n\nNo wallet configured — set WALLET_PRIVATE_KEY in .env to enable real-fund trading.", backKeyboard());
    }
    const balances = await Promise.all(
      Object.entries(CHAINS).map(async ([key, def]) => {
        const chain = { key, ...def };
        const [bal, nativeUsdPrice] = await Promise.all([
          getNativeBalance(chain).catch(() => null),
          getChainNativeUsdPrice(chain).catch(() => null),
        ]);
        return {
          label: def.label,
          balance: bal,
          symbol: def.nativeSymbol,
          usdValue: bal != null && nativeUsdPrice ? bal * nativeUsdPrice : null,
        };
      })
    );
    const lines = [`💳 *Wallet Balance*`, "", `\`${walletAddress}\``, ""];
    let totalUsd = 0;
    let hasAnyUsd = false;
    for (const b of balances) {
      const nativePart = b.balance != null ? `${b.balance.toFixed(6)} ${b.symbol}` : "n/a";
      const usdPart = b.usdValue != null ? ` (${fmtUsd(b.usdValue)})` : "";
      if (b.usdValue != null) {
        totalUsd += b.usdValue;
        hasAnyUsd = true;
      }
      lines.push(`${b.label}: ${nativePart}${usdPart}`);
    }
    if (hasAnyUsd) lines.push("", `Total: ${fmtUsd(totalUsd)}`);
    const keyboard = Markup.inlineKeyboard([
      [Markup.button.callback("🔄 Refresh", "menu:walletbalance")],
      [Markup.button.callback("🔙 Menu", "menu:home")],
    ]);
    await safeEdit(ctx, lines.join("\n"), keyboard);
  }

  bot.action("menu:walletbalance", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
    await ctx.answerCbQuery();
    await renderWalletBalance(ctx);
  });

  // Best-effort summary of what the CURRENT wallet holds, shown before
  // create/import overwrites it — creating or importing a new key doesn't
  // move any existing funds, it just points the bot at a different wallet,
  // so anything left in the old one becomes unmanaged unless withdrawn first.
  async function summarizeCurrentWalletFunds() {
    const address = getWalletAddress();
    if (!address) return null;
    const parts = [];
    for (const [key, def] of Object.entries(CHAINS)) {
      const chain = { key, ...def };
      const bal = await getNativeBalance(chain).catch(() => null);
      if (bal && bal > 0) parts.push(`${bal.toFixed(6)} ${def.nativeSymbol} (${def.label})`);
    }
    return { address, parts };
  }

  bot.action("menu:wallet", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
    await ctx.answerCbQuery();
    if (!(await requireWalletUnlock(ctx))) return;
    const address = getWalletAddress();
    const text = renderWalletSetupText(address);
    await safeEdit(ctx, text, walletMenuKeyboard(Boolean(address)));
  });

  bot.action("walletcreateconfirm", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
    await ctx.answerCbQuery();
    if (!(await requireWalletUnlock(ctx))) return;
    const current = await summarizeCurrentWalletFunds();
    const lines = ["🆕 *Create a new wallet?*", ""];
    if (current) {
      lines.push(`Current wallet \`${current.address}\` will stop being used.`);
      lines.push(current.parts.length ? `It still holds: ${current.parts.join(", ")}` : "It has no funds detected on any configured chain.");
      lines.push("", "Those funds do NOT move automatically — withdraw them first if you want to keep them.");
    }
    lines.push("", "The new wallet's private key will be shown once, right after creation. Save it immediately — it won't be shown again automatically (use Reveal later if needed).");
    await safeEdit(ctx, lines.join("\n"), walletCreateConfirmKeyboard());
  });

  bot.action("walletcreate", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
    await ctx.answerCbQuery("Creating…");
    if (!(await requireWalletUnlock(ctx))) return;
    const wallet = Wallet.createRandom();
    saveWalletPrivateKey(wallet.privateKey);
    await safeEdit(ctx, `✅ *New wallet created*\n\n\`${wallet.address}\``, walletMenuKeyboard(true));
    const sent = await ctx.reply(
      `🔐 Private key (save this now — this message self-deletes in 60s):\n\n\`${wallet.privateKey}\``,
      { parse_mode: "Markdown" }
    );
    setTimeout(() => {
      ctx.deleteMessage(sent.message_id).catch(() => {});
    }, 60_000);
  });

  bot.action("walletimportconfirm", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
    await ctx.answerCbQuery();
    if (!(await requireWalletUnlock(ctx))) return;
    const current = await summarizeCurrentWalletFunds();
    const lines = ["📥 *Import a private key?*", ""];
    if (current) {
      lines.push(`Current wallet \`${current.address}\` will stop being used.`);
      lines.push(current.parts.length ? `It still holds: ${current.parts.join(", ")}` : "It has no funds detected on any configured chain.");
      lines.push("", "Those funds do NOT move automatically — withdraw them first if you want to keep them.");
    }
    lines.push("", "You'll be asked to paste the private key next — your message gets deleted immediately after the bot reads it.");
    await safeEdit(ctx, lines.join("\n"), walletImportConfirmKeyboard());
  });

  bot.action("walletimportstart", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
    await ctx.answerCbQuery();
    if (!(await requireWalletUnlock(ctx))) return;
    setPending(ctx.chat.id, { type: "walletImportKey" });
    await ctx.reply("Send the private key to import (starts with `0x`). Your message will be deleted right after this is processed.", {
      parse_mode: "Markdown",
    });
  });

  bot.action("walletreveal", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
    await ctx.answerCbQuery();
    if (!(await requireWalletUnlock(ctx))) return;
    const privateKey = getPrivateKeyForExport();
    if (!privateKey) return ctx.reply("No wallet configured.");
    const sent = await ctx.reply(`🔐 Private key (this message self-deletes in 60s):\n\n\`${privateKey}\``, { parse_mode: "Markdown" });
    setTimeout(() => {
      ctx.deleteMessage(sent.message_id).catch(() => {});
    }, 60_000);
  });

  bot.action("menu:home", async (ctx) => {
    await ctx.answerCbQuery();
    await safeEdit(ctx, welcomeText(), mainMenuKeyboard());
  });

  bot.action("menu:toggleBot", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const nowPaused = !isPaused();
    setPaused(nowPaused);
    await ctx.answerCbQuery(nowPaused ? "Bot paused" : "Bot resumed");
    await safeEdit(ctx, welcomeText(), mainMenuKeyboard());
  });

  bot.action("menu:togglecallschannel", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const now = !isCallsChannelEnabled();
    setCallsChannelEnabled(now);
    await ctx.answerCbQuery(now ? "Calls will now post to the channel" : "Calls muted — channel won't get them (you still do here)");
    await safeEdit(ctx, welcomeText(), mainMenuKeyboard());
  });

  bot.action("menu:status", async (ctx) => {
    await ctx.answerCbQuery();
    await safeEdit(ctx, renderStatusText(stats), refreshKeyboard("menu:status"));
  });

  // Deliberately NOT gated on OPENSEA_API_KEY. The contract scan and the
  // filter settings underneath this menu are pure RPC and local config —
  // gating the whole menu made the one capability that still works without
  // an aggregator unreachable from the UI, while /nftcheck worked fine by
  // typing it. The individual OpenSea-dependent actions keep their own
  // guard.
  bot.action("menu:nft", async (ctx) => {
    await ctx.answerCbQuery();
    const chainLabels = getNftChainDefs().map((c) => c.label).join(", ") || "none configured";
    await safeEdit(
      ctx,
      `🖼 *NFTs*\n\nNew-collection sniping + wallet copy-trading on ${chainLabels}, via OpenSea. NFT exits list on the marketplace and wait for a buyer — not an instant swap like token trading.`,
      nftMenuKeyboard()
    );
  });

  bot.action("menu:nfttogglenotifications", async (ctx) => {
    if (!requireOpensea(ctx)) return;
    const next = !isNftNotificationsEnabled();
    setNftNotificationsEnabled(next);
    await ctx.answerCbQuery(next ? "NFT notifications on" : "NFT notifications muted");
    const chainLabels = getNftChainDefs().map((c) => c.label).join(", ") || "none configured";
    await safeEdit(
      ctx,
      `🖼 *NFTs*\n\nNew-collection sniping + wallet copy-trading on ${chainLabels}, via OpenSea. NFT exits list on the marketplace and wait for a buyer — not an instant swap like token trading.`,
      nftMenuKeyboard()
    );
  });

  // Filter settings are a local JSON file; nothing here calls OpenSea, and
  // the contract gates in particular must stay configurable on a deployment
  // that has no OpenSea key at all.
  bot.action("menu:nftfilter", async (ctx) => {
    await ctx.answerCbQuery();
    const filters = loadNftFilters();
    await safeEdit(ctx, renderNftFiltersText(filters), nftFilterKeyboard(filters));
  });

  bot.action(/^nftfilteredit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized to change filters.");
    const key = ctx.match[1];
    const filters = loadNftFilters();
    if (!(key in filters)) return ctx.reply("Unknown filter key.");
    setPending(ctx.chat.id, { type: "nftFilter", key });
    await ctx.reply(`Send the new value for *${key}* (current: ${filters[key]}):`, { parse_mode: "Markdown" });
  });

  // ── Mint wallets ──────────────────────────────────────────────────────
  // Keys are IMPORTED, never generated. A bot that mints its own keys decides
  // how much of your money lives somewhere you did not choose.
  // Balances are shown because an unfunded wallet is the single most common
  // reason a mint fails, and it surfaces as a simulation revert — which reads
  // like a contract problem and sends you looking in the wrong place. Both
  // chains, because a wallet funded on Base mints nothing on Robinhood.
  const renderMintWallets = async () => {
    const wallets = listMintWallets();
    const balances = new Map();
    await Promise.all(
      wallets.flatMap((w) =>
        getNftChainKeys().map(async (key) => {
          const bal = await getProvider({ key, ...CHAINS[key] })
            .getBalance(w.address)
            .catch(() => null);
          balances.set(`${w.address}:${key}`, bal);
        })
      )
    );
    return renderMintWalletsWith(wallets, balances);
  };

  const renderMintWalletsWith = (wallets, balances) => {
    if (wallets.length === 0) {
      return [
        "💼 *Mint wallets*",
        "",
        "None imported.",
        "",
        "Fund these with what a mint costs, not a treasury — keys are stored in",
        "plaintext on this machine, the same trust boundary as the trading wallet.",
      ].join("\n");
    }
    const lowBalanceWei = 1000000000000000n;
    const chainSummary = getNftChainKeys().map((key) => {
      const balList = wallets
        .map((w) => balances.get(`${w.address}:${key}`))
        .filter((bal) => bal != null);
      const funded = balList.filter((bal) => bal > 0n).length;
      const ready = balList.filter((bal) => bal >= lowBalanceWei).length;
      const lowest = balList.length ? balList.reduce((min, bal) => (bal < min ? bal : min), balList[0]) : null;
      const lowCount = balList.filter((bal) => bal > 0n && bal < lowBalanceWei).length;
      return `• ${key}: ${funded}/${wallets.length} funded${ready ? `, ${ready} above 0.001 ETH` : ""}${lowCount ? `, ${lowCount} low` : ""}${lowest != null ? `, low ${Number(formatEther(lowest)).toFixed(5)} ETH` : ""}`;
    });
    const fmtBal = (w) =>
      getNftChainKeys()
        .map((key) => {
          const bal = balances.get(`${w.address}:${key}`);
          return `${key} ${bal == null ? "?" : Number(formatEther(bal)).toFixed(5)}`;
        })
        .join(" · ");

    return [
      `💼 *Mint wallets* (${wallets.length})`,
      "",
      ...chainSummary,
      "",
      ...wallets.flatMap((w, i) => [
        `${i + 1}. \`${w.address}\``,
        `   ${fmtBal(w)}`,
      ]),
      "",
      "_Keys are stored in plaintext on this machine. Fund these with mint money only._",
    ].join("\n");
  };

  const shortAddress = (address) => `${address.slice(0, 8)}…${address.slice(-4)}`;

  const renderMintWalletPicker = (config) => {
    const wallets = listMintWallets();
    const selected = new Set((config.walletAddresses ?? []).map((a) => a.toLowerCase()));
    const rows = wallets.map((w, i) => [
      Markup.button.callback(
        `${selected.has(w.address.toLowerCase()) ? "✅" : "⬜"} #${i + 1} ${shortAddress(w.address)}`,
        `mint:walletpick:${i}`
      ),
    ]);
    rows.push(
      [
        Markup.button.callback("✅ Done", "mint:wallets:done"),
        Markup.button.callback("↩ Use first N", "mint:wallets:clear"),
      ],
      [Markup.button.callback("🔄 Refresh", "mint:wallets:choose")],
      [Markup.button.callback("🔙 Back", "mint:refresh")],
    );
    const choice = config.walletAddresses?.length
      ? `selected ${config.walletAddresses.length} wallet${config.walletAddresses.length === 1 ? "" : "s"}`
      : `first ${Math.max(config.wallets, 1)} wallet${Math.max(config.wallets, 1) === 1 ? "" : "s"} in roster order`;
    return {
      text: [
        "💼 *Pick mint wallets*",
        "",
        `Current mode: ${choice}`,
        "",
        "Tap wallets to toggle them on or off.",
        "If you do nothing, the bot mints from the first N wallets in roster order.",
      ].join("\n"),
      keyboard: Markup.inlineKeyboard(rows),
    };
  };

  const mintWalletsKeyboard = () =>
    Markup.inlineKeyboard([
      [Markup.button.callback("🆕 Generate a wallet", "mintwallet:generate")],
      [Markup.button.callback("➕ Import private key(s)", "mintwallet:import")],
      ...(countMintWallets() > 0 ? [[Markup.button.callback("🗑 Remove one", "mintwallet:removeprompt")]] : []),
      [Markup.button.callback("🔄 Refresh balances", "menu:mintwallets")],
      [Markup.button.callback("🔙 Menu", "menu:home")],
    ]);

  bot.command("mintwallets", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    await ctx.reply(await renderMintWallets(), { parse_mode: "Markdown", ...mintWalletsKeyboard() });
  });

  bot.action("menu:mintwallets", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.", { show_alert: true });
    await safeEdit(ctx, await renderMintWallets(), mintWalletsKeyboard());
  });

  bot.action("mintwallet:import", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.", { show_alert: true });
    setPending(ctx.chat.id, { type: "mintWalletImport" });
    await ctx.reply(
      [
        "Paste the private key(s) — one per line, or separated by spaces.",
        "",
        "The message is deleted the moment it arrives, valid or not.",
        "Fund these with what a mint costs. Not a main wallet.",
      ].join("\n")
    );
  });

  // Generating a wallet is offered, not hidden behind a CLI script — but the
  // key is always shown once so it is yours, not only the bot's. Same
  // self-deleting pattern the trading side already uses: long enough to save
  // it, short enough not to sit in chat history forever.
  //
  // The roster file is still the only copy after that message goes. That is
  // stated every time rather than once, because the failure is silent until
  // the day it matters.
  bot.action("mintwallet:generate", async (ctx) => {
    await ctx.answerCbQuery("Generating…");
    if (!isAdmin(ctx)) return;

    const wallet = Wallet.createRandom();
    const results = importMintWallets(wallet.privateKey);
    if (!results[0]?.ok) return ctx.reply(`Couldn't add it: ${results[0]?.reason}`);

    await ctx.reply(
      [
        "🆕 *New mint wallet*",
        "",
        `\`${wallet.address}\``,
        "",
        "Send it a little ETH on the chain you mint on — gas is tiny (a 5-mint",
        "measured ~0.000003 ETH), so a small amount lasts a long time.",
        "",
        `Roster now holds ${countMintWallets()} wallet(s).`,
      ].join("\n"),
      { parse_mode: "Markdown" }
    );

    const keyMsg = await ctx.reply(
      [
        "🔐 *Private key — save it now.*",
        "This message deletes itself in 90 seconds.",
        "",
        `\`${wallet.privateKey}\``,
        "",
        "After it goes, `data/mintWallets.json` on your machine is the only copy.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
    setTimeout(() => ctx.deleteMessage(keyMsg.message_id).catch(() => {}), 90_000);
  });

  bot.action("mintwallet:removeprompt", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return;
    setPending(ctx.chat.id, { type: "mintWalletRemove" });
    await ctx.reply("Send the address to remove.");
  });

  // ── Mint configuration ────────────────────────────────────────────────
  // Every control re-renders from the session, so the numbers on screen are
  // always the ones a mint would use. Nothing here signs or sends.
  const hydrateMintCard = async (chatId, current) => {
    if (!current) return null;
    const chain = current.chain;
    const isMintable = Boolean(current.detect?.mintVia);
    const [extras, roundTrip, walletEligibility] = await Promise.all([
      loadCardExtras(chain, { slug: current.openseaSlug, contractAddress: current.contractAddress }),
      isMintable ? loadRoundTrip(chain, { detect: current.detect, contractAddress: current.contractAddress }) : Promise.resolve(null),
      isMintable
        ? checkWalletEligibility(chain, {
            detect: current.detect,
            contractAddress: current.contractAddress,
            quantity: current.quantity,
            walletAddresses: mintSession.selectedWalletAddresses(current),
          }).catch(() => null)
        : Promise.resolve(null),
    ]);
    return mintSession.startSession(chatId, {
      chain: current.chain,
      contractAddress: current.contractAddress,
      detect: current.detect,
      openseaSlug: current.openseaSlug,
      quantity: current.quantity,
      wallets: current.wallets,
      walletAddresses: current.walletAddresses,
      priceOverrideWei: current.priceOverrideWei,
      roundTrip,
      walletEligibility,
      ...extras,
    });
  };

  const redrawMint = async (ctx, current) => {
    if (!current) return ctx.answerCbQuery("That mint session expired — run /mint again.");
    const config = await hydrateMintCard(ctx.chat.id, current);
    if (!config) return ctx.answerCbQuery("That mint session expired — run /mint again.");
    await safeEdit(ctx, buildMintConfigText(config), mintConfigKeyboard(config), mintCardExtra(config));
  };

  bot.action("mint:noop", (ctx) => ctx.answerCbQuery());

  // Buy the cheapest live listing, for a collection whose mint is over.
  //
  // Gated by the same switches as minting — execution enabled, dry run off —
  // because it spends the same wallets from the same balance. A separate set
  // of toggles would mean turning minting off did not stop this from
  // spending.
  //
  // maxPriceEth is the listing price we showed you and nothing looser: the
  // listing can be filled by someone else between rendering and tapping, and
  // the executor must not silently fill a dearer one in its place.
  bot.action("mint:buyfloor", async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That session expired — paste the address again.");
    if (!config.listing?.priceEth) return ctx.reply("No live listing to buy — tap 🔄 Refresh.");

    const settings = loadMintExecutionSettings();
    if (!settings.enabled) return ctx.reply("⛔️ Execution is disabled. Turn it on in mint settings first.");
    if (settings.dryRun) {
      return ctx.reply(
        [
          "🧪 *Dry run — nothing was bought.*",
          "",
          `Would fill \`${config.listing.orderHash?.slice(0, 12) ?? "listing"}…\` at *${config.listing.priceEth} ETH*` +
            `${config.listing.tokenId ? ` for #${config.listing.tokenId}` : ""}.`,
          "",
          "Go LIVE in /mintsettings to buy for real.",
        ].join("\n"),
        { parse_mode: "Markdown" }
      );
    }

    await ctx.reply(`Buying floor at ${config.listing.priceEth} ETH…`);
    try {
      const result = await buyNftCollectionFloor(config.chain, {
        contractAddress: config.contractAddress,
        maxPriceEth: config.listing.priceEth,
      });
      await ctx.reply(
        `🛒 *Bought* ${result?.tokenId ? `#${result.tokenId}` : ""} for ${result?.priceEth ?? config.listing.priceEth} ETH\n\`${result?.txHash ?? ""}\``,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      await ctx.reply(`Buy failed: ${err.shortMessage || err.message}`);
    }
  });

  // Re-reads the drop. Worth its own button because these change under you:
  // a collection's advertised price and per-wallet cap were both observed
  // changing within a day, and a stale card is how you mint at a price that
  // no longer exists.
  bot.action("mint:refresh", async (ctx) => {
    await ctx.answerCbQuery("Re-reading…");
    const current = mintSession.getSession(ctx.chat.id);
    if (!current) return ctx.reply("That mint session expired — paste the address again.");
    try {
      const [detect, extras] = await Promise.all([
        detectNftMint(current.chain, current.contractAddress, { budgetMs: 8000 }),
        loadCardExtras(current.chain),
      ]);
      const config = mintSession.startSession(ctx.chat.id, {
        chain: current.chain,
        contractAddress: current.contractAddress,
        detect,
        // Carried through refresh: the slug does not change, and losing the
        // balance on refresh would make the card worse each time you tapped it.
        openseaSlug: current.openseaSlug,
        quantity: current.quantity,
        wallets: current.wallets,
        walletAddresses: current.walletAddresses,
        priceOverrideWei: current.priceOverrideWei,
        ...extras,
      });
      await redrawMint(ctx, config);
    } catch (err) {
      await ctx.reply(`Couldn't refresh: ${err.message}`);
    }
  });

  // Typed entry, because these drops advertise caps of 60 and more.
  bot.action("mint:qty:type", async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");
    setPending(ctx.chat.id, { type: "mintQuantity" });
    const max = config.detect.phase?.maxPerWallet;
    await ctx.reply(`Send the quantity per wallet${max ? ` (1–${max})` : ""}:`);
  });

  bot.action("mint:wal:type", async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");
    setPending(ctx.chat.id, { type: "mintWalletCount" });
    await ctx.reply(`Send how many wallets to mint from (1–${countMintWallets()}):`);
  });

  bot.action("mint:wallets:choose", async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");
    const picker = renderMintWalletPicker(config);
    await safeEdit(ctx, picker.text, picker.keyboard);
  });

  bot.action(/^mint:walletpick:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");
    const wallets = listMintWallets();
    const wallet = wallets[Number(ctx.match[1])];
    if (!wallet) return ctx.answerCbQuery("That wallet is no longer available.");
    const current = mintSession.selectedWalletAddresses(config) ?? [];
    const addr = wallet.address.toLowerCase();
    const next = current.includes(addr) ? current.filter((a) => a !== addr) : [...current, addr];
    mintSession.setWalletAddresses(ctx.chat.id, next);
    const picker = renderMintWalletPicker(mintSession.getSession(ctx.chat.id));
    await safeEdit(ctx, picker.text, picker.keyboard);
  });

  bot.action("mint:wallets:done", async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");
    await redrawMint(ctx, config);
  });

  bot.action("mint:wallets:clear", async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");
    mintSession.clearWalletAddresses(ctx.chat.id);
    await redrawMint(ctx, mintSession.getSession(ctx.chat.id));
  });

  bot.action(/^mint:wallets:first:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");
    const count = Math.max(1, Number(ctx.match[1]));
    const wallets = listMintWallets().slice(0, count).map((w) => w.address);
    mintSession.setWalletAddresses(ctx.chat.id, wallets);
    await redrawMint(ctx, mintSession.getSession(ctx.chat.id));
  });

  bot.action("mint:wallets:all", async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");
    const wallets = listMintWallets().map((w) => w.address);
    mintSession.setWalletAddresses(ctx.chat.id, wallets);
    await redrawMint(ctx, mintSession.getSession(ctx.chat.id));
  });

  bot.action(/^mint:qty:(-?\d+|max)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const arg = ctx.match[1];
    const config = arg === "max"
      ? mintSession.setQuantityMax(ctx.chat.id)
      : mintSession.adjustQuantity(ctx.chat.id, Number(arg));
    await redrawMint(ctx, config);
  });

  bot.action(/^mint:wal:(-?\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    await redrawMint(ctx, mintSession.adjustWallets(ctx.chat.id, Number(ctx.match[1])));
  });

  bot.action(/^mint:px:(clear|-?\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const arg = ctx.match[1];
    const config = arg === "clear"
      ? mintSession.clearPriceOverride(ctx.chat.id)
      : mintSession.adjustPriceOverride(ctx.chat.id, BigInt(arg));
    await redrawMint(ctx, config);
  });

  // Runs the configured mint. executeMint refuses on its own for anything
  // structural (disabled, no wallets, over the ceiling, simulated revert) —
  // this only reports what happened.
  const runMint = async (ctx, { quantity: override } = {}) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");

    const walletCount = mintSession.effectiveWalletCount(config);
    const quantity = override ?? config.quantity;

    await ctx.reply(`Sending ${quantity} x ${walletCount} wallet(s)…`);
    try {
      const result = await executeMint(config.chain, {
        detect: config.detect,
        contractAddress: config.contractAddress,
        quantity,
        priceOverrideWei: config.priceOverrideWei,
        walletCount,
        walletAddresses: mintSession.selectedWalletAddresses(config),
      });

      if (!result.ok && result.results.length === 0) {
        return ctx.reply(`⛔️ ${result.reason}`);
      }
      const sent = result.results.filter((r) => r.ok);
      const failed = result.results.filter((r) => !r.ok);
      const dry = sent.some((r) => r.stage === "dry-run");
      const lines = [
        !sent.length
          ? "⛔️ *Nothing sent*"
          : dry
            ? `🧪 *Dry run — ${sent.length}/${result.results.length} would succeed.* Nothing was broadcast.`
            : `🚀 *Sent ${sent.length}/${result.results.length}*`,
        ...sent.map((r) =>
          r.stage === "dry-run"
            ? `  ✅ \`${r.address.slice(0, 10)}…\` would send ${formatEther(r.valueWei)} ETH to \`${r.to.slice(0, 10)}…\` (gas ${r.gasLimit})`
            : `  ✅ \`${r.address.slice(0, 10)}…\` \`${r.txHash}\``
        ),
        ...failed.map((r) => `  ⚠️ \`${r.address.slice(0, 10)}…\` ${r.stage}: ${r.reason}`),
      ];
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });

      // A hash is not a result. Wait for the receipt and report what the
      // wallet actually owns — a mint can revert, or deliver fewer than asked.
      const landed = sent.filter((r) => r.txHash);
      if (landed.length) {
        await ctx.reply("Waiting for confirmation…");
        for (const r of landed) {
          const confirmed = await confirmMint(config.chain, {
            txHash: r.txHash,
            contractAddress: config.contractAddress,
            walletAddress: r.address,
          }).catch((e) => ({ ok: false, pending: false, txHash: r.txHash, reason: e.message }));

          const extras = await loadCardExtras(config.chain, {
            slug: config.openseaSlug,
            contractAddress: config.contractAddress,
          }).catch(() => ({}));

          mintSession.setLastResult(ctx.chat.id, confirmed);
          // Remember what landed, so "My NFTs" has somewhere to look. The
          // record is only a candidate list — ownership is re-read from the
          // chain every time it is displayed — so a stale row here is
          // harmless, while a missing one would hide a real NFT.
          if (confirmed.ok && confirmed.tokenIds?.length) {
            recordAcquisition({
              chainKey: config.chain.key,
              contractAddress: config.contractAddress,
              walletAddress: r.address,
              tokenIds: confirmed.tokenIds,
              name: confirmed.name,
              txHash: r.txHash,
              pricePaidWei: r.valueWei ?? null,
            });
          }
          await ctx.reply(
            buildMintResultText({
              result: confirmed,
              chain: config.chain,
              contractAddress: config.contractAddress,
              stats: extras.stats,
              ethUsd: extras.ethUsd,
              listing: extras.listing,
            }),
            { parse_mode: "Markdown", ...mintResultKeyboard({ result: confirmed, stats: extras.stats }) }
          );
        }
      }
    } catch (err) {
      await ctx.reply(`Mint failed: ${err.message}`);
    }
  };

  // Lists the tokens this session just minted, priced off the floor.
  //
  // Only those token ids — never the wallet's whole balance. Sweeping up
  // unrelated holdings because they share a contract is not something a mint
  // confirmation should be able to do.
  const listAtFloor = async (ctx, pct) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    const result = mintSession.getLastResult(ctx.chat.id);
    if (!config || !result?.tokenIds?.length) return ctx.reply("Nothing to list — mint something first.");

    const settings = loadMintExecutionSettings();
    if (!settings.enabled) return ctx.reply("⛔️ Execution is disabled.");

    const extras = await loadCardExtras(config.chain, { slug: config.openseaSlug, contractAddress: config.contractAddress });
    // Refuse a non-positive floor outright. OpenSea reports 0 when nothing is
    // listed, and pricing a sale off that would list the token for free — the
    // one mistake here that cannot be undone once someone fills it.
    const floor = extras.stats?.floorPriceEth;
    if (floor == null || !(floor > 0)) {
      return ctx.reply("No floor to price against yet — nothing has sold on the secondary market, so there is no price to match.");
    }
    const priceEth = Number((floor * (pct / 100)).toFixed(6));
    if (!(priceEth > 0)) return ctx.reply("Refusing to list at zero.");

    if (settings.dryRun) {
      return ctx.reply(
        `🧪 *Dry run* — would list ${result.tokenIds.map((i) => "#" + i).join(", ")} at *${priceEth} ETH* each. Nothing was listed.`,
        { parse_mode: "Markdown" }
      );
    }

    // The minting burner is the offerer, not WALLET_PRIVATE_KEY — it is the
    // only address that owns these tokens.
    const sellSigner = result.walletAddress
      ? await signerForMintWallet(config.chain, result.walletAddress)
      : null;
    if (result.walletAddress && !sellSigner) {
      return ctx.reply(`\`${result.walletAddress}\` is no longer in the mint wallet roster, so there is no key to sign a listing with.`, { parse_mode: "Markdown" });
    }

    await ctx.reply(`Listing ${result.tokenIds.length} token(s) at ${priceEth} ETH…`);
    for (const tokenId of result.tokenIds) {
      try {
        const r = await listNftForSale(config.chain, {
          contractAddress: config.contractAddress,
          signer: sellSigner,
          tokenId,
          priceEth,
          collectionSlug: config.openseaSlug,
        });
        await ctx.reply(`🏷 Listed #${tokenId} at ${priceEth} ETH`, { parse_mode: "Markdown" });
      } catch (err) {
        await ctx.reply(`Couldn't list #${tokenId}: ${err.shortMessage || err.message}`);
      }
    }
  };

  // ── My NFTs ──────────────────────────────────────────────────────────────
  //
  // What the mint wallets hold right now, priced off the floor. Answers the
  // one question a mint bot leaves open once a mint lands: the NFT went to a
  // burner from data/mintWallets.json, not to whatever wallet app is on the
  // phone, so without this view there is nowhere in the bot to see it.
  //
  // Ownership is re-read from the chain on every open. The local record only
  // says where to look — see mint/nftHoldings.js.

  // The keyboard addresses collections by index, so the exact list a button
  // was drawn against has to survive until it is tapped. Re-deriving it on
  // click would re-sort as floors move and sell the wrong collection.
  const lastHoldings = new Map();

  const showHoldings = async (ctx, { edit = false } = {}) => {
    const loading = edit ? null : await ctx.reply("🖼 Reading your wallets…");
    try {
      const holdings = await loadHoldings();
      // Pricing is best-effort and deliberately after the fact: ownership is
      // an on-chain fact and must never be withheld because OpenSea is having
      // a bad minute.
      await priceHoldings(holdings.groups).catch(() => {});
      const { getEthUsd } = await import("../mint/nativePrice.js");
      const ethUsd = await getEthUsd().catch(() => null);

      lastHoldings.set(ctx.chat.id, holdings);
      const text = buildHoldingsText({ holdings, ethUsd });
      if (edit) await safeEdit(ctx, text, holdingsKeyboard(holdings), holdingsExtra);
      else await ctx.reply(text, { ...holdingsExtra, ...holdingsKeyboard(holdings) });
    } catch (err) {
      await ctx.reply(`Couldn't read holdings: ${err.message}`);
    } finally {
      if (loading) await ctx.telegram.deleteMessage(ctx.chat.id, loading.message_id).catch(() => {});
    }
  };

  bot.command(["holdings", "nfts"], (ctx) => showHoldings(ctx));
  bot.action("menu:holdings", async (ctx) => {
    await ctx.answerCbQuery();
    await showHoldings(ctx);
  });
  bot.action("hold:refresh", async (ctx) => {
    await ctx.answerCbQuery("Refreshing…");
    await showHoldings(ctx, { edit: true });
  });

  // Lists one held collection at its floor, signed by the wallet that holds
  // it. Same zero-floor refusal as the mint result card: OpenSea reports a
  // floor of 0 when nothing is listed, and pricing a sale off that gives the
  // token away — the one mistake here nobody can undo once it is filled.
  bot.action(/^hold:sell:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const holdings = lastHoldings.get(ctx.chat.id);
    const group = holdings?.groups?.[Number(ctx.match[1])];
    if (!group) return ctx.reply("That list is stale — open *My NFTs* again.", { parse_mode: "Markdown" });

    const settings = loadMintExecutionSettings();
    if (!settings.enabled) return ctx.reply("⛔️ Execution is disabled.");
    if (group.floorEth == null || !(group.floorEth > 0)) {
      return ctx.reply("No floor to price against — nothing has resold, so there is no price to match.");
    }

    const priceEth = Number(group.floorEth.toFixed(6));
    if (!(priceEth > 0)) return ctx.reply("Refusing to list at zero.");

    const chain = { key: group.chainKey, ...CHAINS[group.chainKey] };
    if (settings.dryRun) {
      return ctx.reply(
        `🧪 *Dry run* — would list ${group.tokens.map((t) => "#" + t.tokenId).join(", ")} at *${priceEth} ETH* each. Nothing was listed.`,
        { parse_mode: "Markdown" }
      );
    }

    await ctx.reply(`Listing ${group.tokens.length} token(s) at ${priceEth} ETH…`);
    for (const token of group.tokens) {
      try {
        // Per token, because one collection's tokens can sit in different
        // burners once more than one wallet minted the same drop.
        const signer = await signerForMintWallet(chain, token.walletAddress);
        if (!signer) {
          await ctx.reply(`Skipped #${token.tokenId} — \`${token.walletAddress}\` is not in the mint wallet roster.`, { parse_mode: "Markdown" });
          continue;
        }
        await listNftForSale(chain, {
          contractAddress: group.contractAddress,
          signer,
          tokenId: token.tokenId,
          priceEth,
          collectionSlug: group.slug,
        });
        await ctx.reply(`🏷 Listed #${token.tokenId} at ${priceEth} ETH`);
      } catch (err) {
        await ctx.reply(`Couldn't list #${token.tokenId}: ${err.shortMessage || err.message}`);
      }
    }
  });

  bot.action("mint:sellfloor", (ctx) => listAtFloor(ctx, 100));
  bot.action("mint:sellfloor:110", (ctx) => listAtFloor(ctx, 110));

  bot.action("mint:confirm", (ctx) => runMint(ctx));

  // SWEEP probes for the largest quantity that ACTUALLY mints, then asks how
  // much of it you want — it does not decide for you.
  //
  // The probe matters because the advertised cap has been observed to be
  // unmintable: KITTIHOOD's getPublicDrop claimed 6, reverted at 6, and was
  // fine at 5. Sweeping to the advertised number walks straight into a revert
  // at the moment the button exists to avoid waste.
  bot.action("mint:sweep", async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");

    const wallets = listMintWallets();
    if (wallets.length === 0) return ctx.reply("No wallets imported.");

    await ctx.reply("🧹 Probing for the largest quantity that actually mints…");
    const advertised = config.detect.phase?.maxPerWallet ?? config.quantity;
    let realMax;
    try {
      realMax = await findMaxMintable(config.chain, {
        detect: config.detect,
        contractAddress: config.contractAddress,
        priceOverrideWei: config.priceOverrideWei,
        from: wallets[0].address,
        maxQuantity: advertised,
      });
    } catch (err) {
      return ctx.reply(`Couldn't probe: ${err.message}`);
    }
    if (realMax === 0) {
      return ctx.reply("⛔️ Nothing mintable from this wallet right now — even a quantity of 1 reverts.");
    }

    // A handful of choices rather than a stepper: sweeping is a decision you
    // make once, and tapping "−" eleven times to get from 12 to 1 is not a
    // decision, it is a chore. Deduped and ascending so the options never
    // repeat on a small cap.
    const walletCount = Math.max(config.wallets, 1);
    const choices = [...new Set([1, Math.ceil(realMax / 4), Math.ceil(realMax / 2), Math.ceil((realMax * 3) / 4), realMax])]
      .filter((n) => n >= 1 && n <= realMax)
      .sort((a, b) => a - b);

    const unit = config.priceOverrideWei ?? config.detect.phase?.priceWei ?? null;
    const costOf = (q) => (unit == null ? "?" : `${Number(formatEther(unit * BigInt(q) * BigInt(walletCount)))} ETH`);

    await ctx.reply(
      [
        `🧹 *Sweep — how many per wallet?*`,
        "",
        advertised && realMax < advertised
          ? `Contract advertises *${advertised}*, but only *${realMax}* actually mints.`
          : `Largest that mints: *${realMax}* per wallet.`,
        `Across ${walletCount} wallet${walletCount === 1 ? "" : "s"}.`,
      ].join("\n"),
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          choices.map((q) => Markup.button.callback(`${q}${q === realMax ? " (max)" : ""}`, `mint:sweepqty:${q}`)),
          choices.map((q) => Markup.button.callback(costOf(q), "mint:noop")),
          [Markup.button.callback("🔙 Back", "mint:refresh")],
        ]),
      }
    );
  });

  bot.action(/^mint:sweepqty:(\d+)$/, (ctx) => runMint(ctx, { quantity: Number(ctx.match[1]) }));

  bot.action("mint:schedule", async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — paste the address again.");

      const res = armMint({
        chain: config.chain,
        contractAddress: config.contractAddress,
        detect: config.detect,
        quantity: config.quantity,
        walletCount: mintSession.effectiveWalletCount(config),
        walletAddresses: mintSession.selectedWalletAddresses(config),
        priceOverrideWei: config.priceOverrideWei,
        chatId: ctx.chat.id,
      });
    if (!res.ok) return ctx.reply(`⛔️ ${res.reason}`);
    await ctx.reply(
      [
        `⏰ *Armed* — ${config.detect.name || config.contractAddress}`,
        `Fires at ${res.startsAt.toISOString().replace("T", " ").slice(0, 19)} UTC`,
        `${config.quantity} per wallet across ${Math.max(config.wallets, 1)} wallet(s)`,
        "",
        "Calldata is built 90s before the open, so firing is a send and nothing else.",
      ].join("\n"),
      { parse_mode: "Markdown" }
    );
  });

  bot.command("armed", async (ctx) => {
    const list = listArmedMints();
    if (list.length === 0) return ctx.reply("Nothing armed.");
    await ctx.reply(
      list.map((a) => `• \`${a.contractAddress}\` — ${a.quantity}x${a.walletCount} at ${a.startsAt.toISOString().slice(0, 19)}Z${a.prepared ? " (prepared)" : ""}`).join("\n"),
      { parse_mode: "Markdown" }
    );
  });

  bot.command("disarm", async (ctx) => {
    const m = ctx.message.text.match(/0x[a-fA-F0-9]{40}/);
    if (!m) return ctx.reply("Usage: /disarm <contractAddress>");
    const gone = getNftChainKeys().some((k) => disarmMint(k, m[0]));
    await ctx.reply(gone ? "Disarmed." : "Nothing armed for that address.");
  });

  bot.command("mintsettings", async (ctx) => {
    if (!isAdmin(ctx)) return;
    const st = loadMintExecutionSettings();
    await ctx.reply(
      [
        "⚙️ *Mint execution*",
        `• Enabled: *${st.enabled ? "yes" : "no"}*`,
        `• Mode: *${st.dryRun ? "🧪 DRY RUN — builds and simulates, never sends" : "🔴 LIVE — will broadcast and spend"}*`,
        `• Max spend per run: ${st.maxSpendEthPerRun} ETH`,
        `• Gas limit multiplier: ${st.gasLimitMultiplier}`,
        `• Require simulation: ${st.requireSimulation}`,
      ].join("\n"),
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback(st.enabled ? "🔴 Disable minting" : "🟢 Enable minting", "mintset:toggle")],
        ]),
      }
    );
  });

  bot.action("menu:mintsettings", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return;
    const st = loadMintExecutionSettings();
    await ctx.reply(
      [
        "⚙️ *Mint execution*",
        `• Enabled: *${st.enabled ? "yes" : "no"}*`,
        `• Mode: *${st.dryRun ? "🧪 DRY RUN — builds and simulates, never sends" : "🔴 LIVE — will broadcast and spend"}*`,
        `• Max spend per run: ${st.maxSpendEthPerRun} ETH`,
        `• Gas limit multiplier: ${st.gasLimitMultiplier}`,
        `• Require simulation: ${st.requireSimulation}`,
      ].join("\n"),
      {
        parse_mode: "Markdown",
        ...Markup.inlineKeyboard([
          [Markup.button.callback(st.enabled ? "⚪️ Disable minting" : "🟢 Enable minting", "mintset:toggle")],
          [Markup.button.callback(st.dryRun ? "🔴 Go LIVE (real spending)" : "🧪 Back to dry run", "mintset:dryrun")],
          [Markup.button.callback("🔙 Menu", "menu:home")],
        ]),
      }
    );
  });

  bot.action("menu:armed", async (ctx) => {
    await ctx.answerCbQuery();
    const list = listArmedMints();
    const empty = "Nothing armed.\n\nPaste a drop that hasn't opened yet, then tap the Schedule Auto-Mint button.";
    const rows = list.map(
      (a) =>
        `• \`${a.contractAddress}\` — ${a.quantity}x${a.walletCount} at ${a.startsAt.toISOString().slice(0, 19)}Z${a.prepared ? " (prepared)" : ""}`
    );
    await ctx.reply(list.length === 0 ? empty : rows.join("\n"), { parse_mode: "Markdown" });
  });

  bot.action("mintset:dryrun", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return;
    const st = loadMintExecutionSettings();
    st.dryRun = !st.dryRun;
    saveMintExecutionSettings(st);
    await ctx.reply(
      st.dryRun
        ? "🧪 Dry run ON. Mints build, simulate and estimate gas — nothing is broadcast."
        : "🔴 LIVE. The next CONFIRM MINT will broadcast real transactions and spend real ETH.",
    );
  });

  bot.action("mintset:toggle", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return;
    const st = loadMintExecutionSettings();
    st.enabled = !st.enabled;
    saveMintExecutionSettings(st);
    await ctx.reply(st.enabled
      ? "🟢 Mint execution ENABLED. This bot can now spend from the imported wallets."
      : "🔴 Mint execution disabled.");
  });

  bot.action("mint:eligibility", async (ctx) => {
    await ctx.answerCbQuery();
    const config = mintSession.getSession(ctx.chat.id);
    if (!config) return ctx.reply("That mint session expired — run /mint again.");
    if (countMintWallets() === 0) {
      return ctx.reply("No wallets imported. Use 💼 Mint wallets → Import private key(s).");
    }

    await ctx.reply("🔍 Checking each wallet…");
    try {
      const rows = await checkWalletEligibility(config.chain, {
        detect: config.detect,
        contractAddress: config.contractAddress,
        quantity: config.quantity,
        walletAddresses: mintSession.selectedWalletAddresses(config),
      });

      const lines = [`🔍 *Eligibility — ${config.quantity} per wallet*`, ""];
      for (const r of rows) {
        const bal = r.balance == null ? "?" : `${Number(formatEther(r.balance)).toFixed(5)} ETH`;
        const allowance = r.remaining == null ? "" : ` · ${r.remaining} left of cap`;
        const minted = r.minted == null ? "" : ` · minted ${r.minted}`;
        lines.push(
          `${r.ok ? "✅" : "❌"} \`${r.address.slice(0, 10)}…\``,
          `   ${bal}${minted}${allowance}`,
          // A failing simulation is only useful with its reason attached —
          // "insufficient funds" and "exceeds max per wallet" need opposite
          // responses, and both look identical as a bare ❌.
          ...(r.ok ? [] : [`   ↳ ${String(r.reason || "would revert").slice(0, 90)}`]),
          ...(r.funded === false ? ["   ⚠️ balance may not cover the mint"] : [])
        );
      }
      await ctx.reply(lines.join("\n"), { parse_mode: "Markdown" });
    } catch (err) {
      await ctx.reply(`Eligibility check failed: ${err.message}`);
    }
  });

  bot.action(/^nftfiltertoggle:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized to change filters.");
    const key = ctx.match[1];
    const filters = loadNftFilters();
    if (!(key in filters) || typeof filters[key] !== "boolean") return ctx.reply("Unknown filter key.");

    filters[key] = !filters[key];
    saveNftFilters(filters);

    // Redraw in place so the checkbox reflects the new state immediately.
    await safeEdit(ctx, renderNftFiltersText(filters), nftFilterKeyboard(filters));
  });

  bot.action("menu:nftwallets", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    const { shown, total } = pageWatchedWallets(getWatchedWallets(), 0);
    await safeEdit(ctx, renderWatchedWalletsText(shown, total, 0), nftWalletsKeyboard(shown, total, 0));
  });

  bot.action(/^nftwalletspage:(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    const offset = Number(ctx.match[1]);
    const { shown, total } = pageWatchedWallets(getWatchedWallets(), offset);
    await safeEdit(ctx, renderWatchedWalletsText(shown, total, offset), nftWalletsKeyboard(shown, total, offset));
  });

  bot.action("nftwalletadd", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    setPending(ctx.chat.id, { type: "nftWalletAdd" });
    await ctx.reply(
      "Send the wallet address or ENS name (`name.eth`) to watch, optionally followed by a label — e.g. `0xabc... whale1` or `vitalik.eth`",
      { parse_mode: "Markdown" }
    );
  });

  // Legacy remove buttons (pre-pagination messages still live in chat
  // history) carry callback data without the :offset suffix — treat them as
  // page 0 rather than silently ignoring the tap.
  bot.action(/^nftwalletremove:(0x[a-fA-F0-9]{40})$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const removed = removeWatchedWallet(ctx.match[1]);
    await ctx.answerCbQuery(removed ? "Removed." : "Not found.");
    const { shown, total } = pageWatchedWallets(getWatchedWallets(), 0);
    await safeEdit(ctx, renderWatchedWalletsText(shown, total, 0), nftWalletsKeyboard(shown, total, 0));
  });

  bot.action(/^nftwalletremove:(0x[a-fA-F0-9]{40}):(\d+)$/, async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const [, address, offsetStr] = ctx.match;
    const removed = removeWatchedWallet(address);
    await ctx.answerCbQuery(removed ? "Removed." : "Not found.");
    // Stay on the same page after removing — re-clamped in case removing
    // the last wallet on the last page would otherwise show an empty page.
    const wallets = getWatchedWallets();
    const offset = Math.min(Number(offsetStr), Math.max(0, wallets.length - 1));
    const { shown, total } = pageWatchedWallets(wallets, offset);
    await safeEdit(ctx, renderWatchedWalletsText(shown, total, offset), nftWalletsKeyboard(shown, total, offset));
  });

  bot.action("menu:nftpapertrading", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    const settings = loadNftPaperTradingSettings();
    const stats = getNftPaperTradingStats();
    await safeEdit(ctx, buildNftTradingSummary({ settings, stats, mode: "paper" }), nftPaperTradingKeyboard(settings));
  });

  bot.action("nftpapertoggle", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    const settings = loadNftPaperTradingSettings();
    settings.enabled = !settings.enabled;
    saveNftPaperTradingSettings(settings);
    await ctx.answerCbQuery(settings.enabled ? "NFT paper trading resumed" : "NFT paper trading paused");
    const stats = getNftPaperTradingStats();
    await safeEdit(ctx, buildNftTradingSummary({ settings, stats, mode: "paper" }), nftPaperTradingKeyboard(settings));
  });

  bot.action(/^nftpaperedit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const key = ctx.match[1];
    const settings = loadNftPaperTradingSettings();
    if (!(key in settings)) return ctx.reply("Unknown setting.");
    setPending(ctx.chat.id, { type: "nftPaperTrading", key });
    await ctx.reply(`Send the new value for *${key}* (current: ${settings[key]}):`, { parse_mode: "Markdown" });
  });

  function renderNftPositionsText(positions, mode) {
    const label = mode === "real" ? "REAL NFT Positions" : "NFT Paper Positions";
    if (positions.length === 0) return `📋 *${label}* (0)\n\nNothing open right now.`;
    const lines = positions.map((p) => {
      const statusTag = p.status === "listed" ? `🏷️ listed at ${p.listed_price_eth} ETH` : "🟢 held";
      return `*${escapeMd(p.name) || "?"}* #${p.token_id} (${p.chain})\n   Entry: ${p.entry_price_eth} ETH | Target: ${p.target_multiple}x | Stop: ${p.stop_floor_pct}% — ${statusTag}`;
    });
    return `📋 *${label}* (${positions.length})\n\n${lines.join("\n\n")}`;
  }

  bot.action("menu:nftpaperactive", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    const positions = getOpenNftPaperTrades();
    await safeEdit(ctx, renderNftPositionsText(positions, "paper"), refreshKeyboard("menu:nftpaperactive"));
  });

  bot.action("menu:nftrealactive", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    if (!(await requireWalletUnlock(ctx))) return;
    const positions = getOpenNftRealTrades();
    await safeEdit(ctx, renderNftPositionsText(positions, "real"), refreshKeyboard("menu:nftrealactive"));
  });

  bot.action("menu:nftrealtrading", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.answerCbQuery("Not authorized.");
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    if (!(await requireWalletUnlock(ctx))) return;
    const settings = loadNftRealTradingSettings();
    const stats = getNftRealTradingStats();
    await safeEdit(ctx, buildNftTradingSummary({ settings, stats, mode: "real" }), nftRealTradingKeyboard(settings, hasWallet()));
  });

  bot.action("nftrealconfirm:enable", async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    if (!(await requireWalletUnlock(ctx))) return;
    if (!hasWallet()) return safeEdit(ctx, "⚠️ No wallet configured. Add WALLET_PRIVATE_KEY to .env first.", nftRealTradingKeyboard(loadNftRealTradingSettings(), false));
    const settings = loadNftRealTradingSettings();
    await safeEdit(
      ctx,
      `⚠️ *This trades NFTs with real money.*\n\nPosition size: ${settings.positionSizeEth} ETH | Budget: ${settings.totalBudgetEth} ETH\n\n` +
        `NFT exits list on OpenSea and wait for a buyer — not a guaranteed or instant sale like token trading. Continue?`,
      nftRealEnableConfirmKeyboard()
    );
  });

  bot.action("nftrealtoggle", async (ctx) => {
    if (!isAdmin(ctx)) {
      await ctx.answerCbQuery("Not authorized.");
      return;
    }
    if (!(await requireWalletUnlock(ctx))) return;
    const settings = loadNftRealTradingSettings();
    if (!settings.enabled && !hasWallet()) {
      await ctx.answerCbQuery("No wallet configured.");
      return safeEdit(ctx, "⚠️ No wallet configured. Add WALLET_PRIVATE_KEY to .env first.", nftRealTradingKeyboard(settings, false));
    }
    settings.enabled = !settings.enabled;
    saveNftRealTradingSettings(settings);
    await ctx.answerCbQuery(settings.enabled ? "🔴 REAL NFT trading enabled" : "Real NFT trading paused");
    const stats = getNftRealTradingStats();
    await safeEdit(ctx, buildNftTradingSummary({ settings, stats, mode: "real" }), nftRealTradingKeyboard(settings, hasWallet()));
  });

  bot.action(/^nftrealedit:(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    if (!(await requireWalletUnlock(ctx))) return;
    const key = ctx.match[1];
    const settings = loadNftRealTradingSettings();
    if (!(key in settings)) return ctx.reply("Unknown setting.");
    setPending(ctx.chat.id, { type: "nftRealTrading", key });
    await ctx.reply(`Send the new value for *${key}* (current: ${settings[key]}):`, { parse_mode: "Markdown" });
  });

  bot.action("menu:nftscore", async (ctx) => {
    await ctx.answerCbQuery();
    if (!requireOpensea(ctx)) return;
    setPending(ctx.chat.id, { type: "nftScore" });
    await ctx.reply("Paste the NFT collection's contract address.");
  });

  // No requireOpensea gate: the scan reads the contract directly, so it is
  // the one NFT check that still works without an OpenSea key.
  bot.action("menu:nftcheck", async (ctx) => {
    await ctx.answerCbQuery();
    setPending(ctx.chat.id, { type: "nftCheck" });
    await ctx.reply(`Paste the contract address to scan (chain: ${getNftChainKeys()[0]}).`);
  });

  // Slash commands still work underneath the buttons, for muscle memory.
  bot.command("status", (ctx) => ctx.reply(renderStatusText(stats), { parse_mode: "Markdown", ...backKeyboard() }));
  bot.command("nftfilter", (ctx) => {
    if (!requireOpensea(ctx)) return ctx.reply("NFT features need OPENSEA_API_KEY set in .env.");
    const filters = loadNftFilters();
    ctx.reply("```\n" + JSON.stringify(filters, null, 2) + "\n```", { parse_mode: "Markdown", ...backKeyboard() });
  });
  bot.command("setnftfilter", (ctx) => {
    if (!requireOpensea(ctx)) return ctx.reply("NFT features need OPENSEA_API_KEY set in .env.");
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const [, key, rawValue] = ctx.message.text.split(/\s+/);
    if (!key || rawValue === undefined) return ctx.reply("Usage: /setnftfilter <key> <value>");
    const filters = loadNftFilters();
    if (!(key in filters)) return ctx.reply(`Unknown filter key. Valid keys: ${Object.keys(filters).join(", ")}`);
    const prev = filters[key];
    filters[key] = typeof prev === "boolean" ? rawValue === "true" : Number(rawValue);
    saveNftFilters(filters);
    ctx.reply(`Updated ${key}: ${prev} → ${filters[key]}`);
  });
  bot.command("nftscore", async (ctx) => {
    if (!requireOpensea(ctx)) return ctx.reply("NFT features need OPENSEA_API_KEY set in .env.");
    const args = ctx.message.text.split(/\s+/).filter(Boolean).slice(1);
    const usage = `Usage: /nftscore <contractAddress> or /nftscore <chain> <contractAddress> (chains: ${getNftChainKeys().join(", ")})`;
    let chainKeyHint, contractAddress;
    if (args.length === 1) {
      contractAddress = args[0];
    } else if (args.length === 2) {
      [chainKeyHint, contractAddress] = args;
      chainKeyHint = chainKeyHint.toLowerCase();
    } else {
      return ctx.reply(usage);
    }
    if (!contractAddress || !ADDRESS_RE.test(contractAddress)) return ctx.reply(usage);
    await ctx.reply("Analyzing…");
    try {
      await scoreAndReplyNft(ctx, contractAddress, chainKeyHint);
    } catch (err) {
      ctx.reply(`Failed to score collection: ${err.message}`);
    }
  });

  // Reads how a collection is minted: standard, price, phase window, max per
  // wallet, and which contract the mint transaction actually goes to. Same
  // no-aggregator discipline as /nftcheck — a mint worth catching is minutes
  // old and OpenSea has never heard of it.
  //
  // Read-only. This sends nothing and needs no key.
  bot.command("mint", async (ctx) => {
    const args = ctx.message.text.split(/\s+/).filter(Boolean).slice(1);
    const usage =
      `Usage: /mint <contractAddress> or /mint <chain> <contractAddress>
` +
      `Chains: ${getNftChainKeys().join(", ")} (defaults to ${getNftChainKeys()[0]})

` +
      `Reads mint price, phase timing and max-per-wallet straight from the contract.`;

    let chainKeyHint, contractAddress;
    if (args.length === 1) contractAddress = args[0];
    else if (args.length === 2) { [chainKeyHint, contractAddress] = args; chainKeyHint = chainKeyHint.toLowerCase(); }
    else return ctx.reply(usage);
    if (!contractAddress || !ADDRESS_RE.test(contractAddress)) return ctx.reply(usage);

    const chainKey = chainKeyHint || getNftChainKeys()[0];
    if (!getNftChainKeys().includes(chainKey) || !CHAINS[chainKey]) {
      return ctx.reply(`Unknown chain. Options: ${getNftChainKeys().join(", ")}`);
    }

    await ctx.reply("Reading mint config…");
    try {
      const chain = { key: chainKey, ...CHAINS[chainKey] };
      const detect = await detectNftMint(chain, contractAddress, { budgetMs: 8000 });
      await ctx.reply(buildMintDetectMessage({ chain, contractAddress, detect }), { parse_mode: "Markdown" });

      // Only offer the configurator when there is something to configure.
      // Putting a quantity stepper under a sold-out drop invites tapping it.
      if (detect.mintVia) {
        const config = mintSession.startSession(ctx.chat.id, { chain, contractAddress, detect });
        await ctx.reply(buildMintConfigText(config), { parse_mode: "Markdown", ...mintConfigKeyboard(config) });
      }
    } catch (err) {
      ctx.reply(`Mint scan failed: ${err.message}`);
    }
  });

  bot.command("nftcheck", async (ctx) => {
    const args = ctx.message.text.split(/\s+/).filter(Boolean).slice(1);
    const usage =
      `Usage: /nftcheck <contractAddress> or /nftcheck <chain> <contractAddress>\n` +
      `Chains: ${getNftChainKeys().join(", ")} (defaults to ${getNftChainKeys()[0]})\n\n` +
      `Static contract scan — no OpenSea, no GoPlus. Works on brand-new contracts.`;

    let chainKeyHint, contractAddress;
    if (args.length === 1) {
      contractAddress = args[0];
    } else if (args.length === 2) {
      [chainKeyHint, contractAddress] = args;
      chainKeyHint = chainKeyHint.toLowerCase();
    } else {
      return ctx.reply(usage);
    }
    if (!contractAddress || !ADDRESS_RE.test(contractAddress)) return ctx.reply(usage);

    await ctx.reply("Reading contract…");
    try {
      await scanAndReplyNftContract(ctx, contractAddress, chainKeyHint);
    } catch (err) {
      ctx.reply(`Scan failed: ${err.message}`);
    }
  });
  bot.command("watchwallet", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const [, rawInput, ...labelParts] = ctx.message.text.split(/\s+/);
    if (!rawInput) return ctx.reply("Usage: /watchwallet <address or name.eth> [label]");
    const resolved = await resolveWalletAddressInput(rawInput);
    if (!resolved) return ctx.reply("That doesn't look like a valid wallet address or resolvable ENS name.");
    const label = labelParts.join(" ") || resolved.label;
    addWatchedWallet(resolved.address, label);
    ctx.reply(`👛 Now watching \`${resolved.address}\`${label ? ` (${escapeMd(label)})` : ""}`, { parse_mode: "Markdown" });
  });
  // Bulk-import version of /watchwallet — one entry per line (address or
  // ENS name, optionally followed by a label), for loading a real
  // watched-wallet list in a handful of messages instead of one per wallet.
  // Telegram itself caps an incoming text message at 4096 chars, so a
  // large list (dozens+) still needs sending in a few chunks — that's fine,
  // addWatchedWallet is idempotent (INSERT ... ON CONFLICT DO UPDATE), so
  // re-sending an overlapping chunk is harmless.
  bot.command("watchwallets", async (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const body = ctx.message.text.replace(/^\/watchwallets(@\w+)?\s*/i, "");
    const entries = body
      .split(/\n+/)
      .map((l) => l.trim())
      .filter(Boolean);
    if (entries.length === 0) {
      return ctx.reply(
        "Usage: /watchwallets followed by one address or ENS name per line (optional label after it), e.g.\n" +
          "/watchwallets\n0xabc... whale1\nvitalik.eth"
      );
    }
    await ctx.reply(`Processing ${entries.length} entries…`);

    let added = 0;
    const failed = [];
    for (const entry of entries) {
      const [rawInput, ...labelParts] = entry.split(/\s+/);
      const resolved = await resolveWalletAddressInput(rawInput);
      if (!resolved) {
        failed.push(entry);
        continue;
      }
      addWatchedWallet(resolved.address, labelParts.join(" ") || resolved.label);
      added++;
    }

    const lines = [`👛 Added/updated ${added} watched wallet(s).`];
    if (failed.length) {
      lines.push(`⚠️ ${failed.length} couldn't be resolved:`, ...failed.slice(0, 15).map((f) => `  ${f}`));
      if (failed.length > 15) lines.push(`  … and ${failed.length - 15} more`);
    }
    ctx.reply(lines.join("\n"));
  });
  bot.command("unwatchwallet", (ctx) => {
    if (!isAdmin(ctx)) return ctx.reply("Not authorized.");
    const [, address] = ctx.message.text.split(/\s+/);
    if (!address) return ctx.reply("Usage: /unwatchwallet <address>");
    const removed = removeWatchedWallet(address);
    ctx.reply(removed ? "Removed." : "Wasn't watching that address.");
  });

  // Free text: either the answer to a button prompt, or a bare pasted
  // address (auto-scored by default with no prompt needed).
  bot.on("text", async (ctx) => {
    const text = ctx.message.text;
    if (text.startsWith("/")) return;

    const pending = takePending(ctx.chat.id);
    if (pending) return handlePendingAction(ctx, pending, text);

    // Mint first. A pasted address or link is a drop someone wants to mint,
    // not a token they want scored — this is a mint bot, and the old
    // token-scoring fallthrough belonged to the trading bot this was seeded
    // from.
    const handled = await handlePastedTarget(ctx, text).catch(async (err) => {
      await ctx.reply(`Failed to read that: ${err.message}`);
      return true;
    });
    if (!handled) return;
  });

  return bot;
}

// Telegram hard-rejects anything over 4096 chars (e.g. a token with an
// absurdly long name/symbol can push a normally-short message over that) —
// truncate defensively rather than let sendMessage throw.
const TELEGRAM_MAX_LENGTH = 4096;
function truncateForTelegram(text) {
  if (text.length <= TELEGRAM_MAX_LENGTH) return text;
  return `${text.slice(0, TELEGRAM_MAX_LENGTH - 20)}\n\n… (truncated)`;
}

// Sends to every configured destination (primary chat + any signal
// channels), independently — one destination failing (e.g. bot removed as
// channel admin) must not block delivery to the others. Returns the primary
// chat's message_id, since that's the only one anything else references.
// The "Post calls to channel" toggle (isCallsChannelEnabled) is honoured
// here rather than at each call site, because the bug it fixes was exactly
// that: it used to be checked only where a call was first posted, so with the
// toggle OFF the call stayed out of the channel while every follow-up about
// that same call still went there. A toggle that silences the call but not
// the running commentary about it isn't off. The primary admin chat always
// receives everything ("admin DM always still gets calls"); the shared
// channels are what the toggle governs.
function activeDestinations() {
  return isCallsChannelEnabled() ? config.telegram.destinations : [config.telegram.chatId];
}

async function broadcast(bot, message, extra = {}) {
  let primaryMessageId = null;
  for (const destination of activeDestinations()) {
    try {
      const sent = await bot.telegram.sendMessage(destination, message, { parse_mode: "Markdown", ...extra });
      if (destination === config.telegram.chatId) primaryMessageId = sent.message_id;
    } catch (err) {
      console.error(`Failed to send to ${destination}:`, err.message);
    }
  }
  return primaryMessageId;
}

// Same as postUpdate, but for NFT-side messages specifically (trade opens/
// closes/listings, comando activations) — gated by the notifications toggle
// so the underlying NFT scanning/paper-trading logic can keep running
// (stats stay meaningful) while Telegram stays quiet. Does not affect
// postNftCall below, which has its own identical check.
export async function postNftUpdate(bot, text) {
  if (!isNftNotificationsEnabled()) return null;
  return broadcast(bot, truncateForTelegram(text));
}

// Telegram caption limit is 1024 chars (much shorter than a text message's
// 4096) — the open/close messages this feeds are already only a few short
// lines, but truncate defensively rather than let sendPhoto throw on an
// unexpectedly long one (e.g. a token with a very long name/symbol).
const TELEGRAM_CAPTION_MAX_LENGTH = 1024;
function truncateCaption(text) {
  if (text.length <= TELEGRAM_CAPTION_MAX_LENGTH) return text;
  return `${text.slice(0, TELEGRAM_CAPTION_MAX_LENGTH - 20)}\n\n… (truncated)`;
}

// Same per-destination independent-delivery discipline as broadcast() above,
// but sends the collection image via sendPhoto (caption = the call text)
// when one is available, falling back to a plain text message otherwise —
// unlike token calls, an NFT call has a real, usually-distinctive image
// worth showing inline rather than just linking out.
// Image hosts that have refused to serve Telegram, learned at runtime. See
// the note in postNftCall for why this is a host set and not a URL set.
const photoUnsupportedHosts = new Set();

export async function postNftCall(bot, { chain, contractAddress, riskResult, source, triggerWalletLabel }) {
  // Scoring/recording/paper-trading for this collection still happens
  // upstream in nftPipeline.js regardless — this only mutes the message
  // itself, same as postNftUpdate above.
  if (!isNftNotificationsEnabled()) return null;
  const message = truncateForTelegram(buildNftCallMessage({ chain, contractAddress, riskResult, source, triggerWalletLabel }));
  // sendPhoto captions cap at 1024 chars — a quarter of a text message's
  // 4096. Truncating both to 4096 meant any flag-heavy call (i.e. exactly
  // the risky ones) failed the photo send on every destination and fell
  // back to text, so images never appeared where they mattered most.
  const caption = truncateCaption(message);
  const imageUrl = riskResult.imageUrl;

  // Telegram fetches a photo URL server-side, and OpenSea's CDN refuses it:
  // every call with an i2c.seadn.io image came back "400: Bad Request: failed
  // to get HTTP URL content" (observed on every one of 7 consecutive calls,
  // 2026-08-18). The text fallback below caught all of them, so nothing was
  // lost — but each call still paid a doomed API round trip and logged an
  // error, which trains you to ignore the error log.
  //
  // So remember which image hosts have refused and stop asking them. Keyed by
  // host rather than URL because the failure is a property of the CDN, not of
  // one image, and held in memory only: a restart re-tests, so a host that
  // starts working is picked up without a code change.
  const imageHost = imageUrl ? URL.parse(imageUrl)?.host ?? null : null;
  const usePhoto = imageUrl && !(imageHost && photoUnsupportedHosts.has(imageHost));

  let primaryMessageId = null;
  // isNftNotificationsEnabled above decides WHETHER an NFT call is sent at
  // all; the channel toggle still decides WHERE, same as every other sender.
  for (const destination of activeDestinations()) {
    try {
      const sent = usePhoto
        ? await bot.telegram.sendPhoto(destination, imageUrl, { caption, parse_mode: "Markdown" })
        : await bot.telegram.sendMessage(destination, message, { parse_mode: "Markdown" });
      if (destination === config.telegram.chatId) primaryMessageId = sent.message_id;
    } catch (err) {
      // Only a fetch failure condemns the host. A caption-too-long or
      // rate-limit error says nothing about whether the CDN serves Telegram.
      if (usePhoto && imageHost && /failed to get HTTP URL content|wrong file identifier|WEBPAGE_MEDIA_EMPTY/i.test(err.message)) {
        photoUnsupportedHosts.add(imageHost);
        console.error(`[nft] ${imageHost} won't serve images to Telegram — sending text only from now on`);
      }
      console.error(`Failed to send NFT call to ${destination}:`, err.message);
      // A bad/unreachable image URL shouldn't lose the call entirely — retry
      // that one destination as a plain text message.
      if (usePhoto) {
        try {
          const sent = await bot.telegram.sendMessage(destination, message, { parse_mode: "Markdown" });
          if (destination === config.telegram.chatId) primaryMessageId = sent.message_id;
        } catch (err2) {
          console.error(`Text fallback also failed for ${destination}:`, err2.message);
        }
      }
    }
  }
  return primaryMessageId;
}

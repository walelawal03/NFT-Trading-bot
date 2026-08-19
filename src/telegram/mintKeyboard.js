import { Markup } from "telegraf";
import { formatEther } from "ethers";
import { totalCostWei } from "../mint/mintSession.js";
import { countMintWallets } from "../mint/mintWallets.js";
import { explorerUrlFor } from "./formatMessage.js";

// One message: what the drop is, and the controls to mint it.
//
// It used to be two — a detail report, then a separate config card — which on
// a phone meant scrolling up to re-check the price before tapping a button at
// the bottom. Everything needed to decide now sits directly above the
// keyboard that acts on it.
//
// Every number here is read from the contract. "Max (3)" is that drop's own
// maxTotalMintableByWallet, not a default; a control showing a plausible
// number it never read is worse than no control, because it gets trusted.

const fmt = (wei) => (wei == null ? "unknown" : `${Number(formatEther(wei))}`);

function fmtWhen(date) {
  if (!date) return null;
  const ms = date.getTime() - Date.now();
  const abs = Math.abs(ms);
  const rel =
    abs < 90 * 60000
      ? `${Math.round(abs / 60000)}m`
      : abs < 48 * 3600000
        ? `${Math.round(abs / 3600000)}h`
        : `${Math.round(abs / 86400000)}d`;
  return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC · ${ms > 0 ? `in ${rel}` : `${rel} ago`}`;
}

export function buildMintConfigText(config) {
  const { detect, chain, contractAddress } = config;
  const unit = config.priceOverrideWei ?? detect.phase?.priceWei ?? null;
  const total = totalCostWei(config);
  const walletsAvailable = countMintWallets();

  const state = detect.soldOut
    ? "🔴 SOLD OUT"
    : detect.mintable === true
      ? "🟢 MINTING NOW"
      : detect.phase?.startsAt && detect.phase.startsAt.getTime() > Date.now()
        ? "🕒 NOT OPEN YET"
        : detect.mintable === false
          ? "🔴 NOT MINTABLE"
          : "⚪️ STATE UNKNOWN";

  const supply =
    detect.totalSupply != null && detect.maxSupply != null
      ? `${detect.totalSupply} / ${detect.maxSupply}`
      : detect.totalSupply != null
        ? `${detect.totalSupply} / ?`
        : "unknown";

  const lines = [
    `🎯 *${detect.name || "Unknown collection"}*${detect.symbol ? ` (${detect.symbol})` : ""}`,
    `${state} · ${chain.label}`,
    "",
    `• Standard: \`${detect.standard}\``,
    `• Supply: ${supply}`,
    `• Price: *${fmt(unit)} ETH* each${detect.phase?.feeBps ? ` _(incl. ${detect.phase.feeBps / 100}% fee)_` : ""}`,
    `• Max per wallet: ${detect.phase?.maxPerWallet ?? "unknown"}`,
  ];

  const opens = fmtWhen(detect.phase?.startsAt);
  const closes = fmtWhen(detect.phase?.endsAt);
  if (opens) lines.push(`• Opens: ${opens}`);
  if (closes) lines.push(`• Closes: ${closes}`);

  const wallets = Math.max(config.wallets, 1);
  lines.push(
    "",
    "⚙️ *Your mint*",
    `• ${config.quantity} per wallet × ${wallets} wallet${wallets === 1 ? "" : "s"} = *${config.quantity * wallets} total*`,
    `• Cost: *${total == null ? "unknown" : `${Number(formatEther(total))} ETH`}*${config.priceOverrideWei != null ? " _(price overridden)_" : ""}`,
    `• Wallets loaded: ${walletsAvailable}`
  );

  // Anything that would stop the mint goes ABOVE the buttons. Someone about
  // to tap CONFIRM should already know it cannot work.
  const blockers = [];
  if (detect.soldOut) blockers.push("sold out");
  if (detect.mintable === false && !detect.soldOut) blockers.push("phase not open");
  if (walletsAvailable === 0) blockers.push("no wallets loaded");
  if (unit == null) blockers.push("price unknown");
  if (blockers.length) lines.push("", `⛔️ *Can't mint:* ${blockers.join(", ")}`);

  const explorer = explorerUrlFor(chain.key, contractAddress);
  lines.push("", `\`${contractAddress}\``);
  if (explorer) lines.push(`[View contract](${explorer})`);

  return lines.join("\n");
}

export function mintConfigKeyboard(config) {
  const { detect } = config;
  const max = detect.phase?.maxPerWallet ?? null;
  const walletsAvailable = countMintWallets();
  const atMax = max != null && config.quantity >= max;
  const total = config.quantity * Math.max(config.wallets, 1);

  // Section headers are full-width no-op buttons. They cost nothing, and on a
  // phone they turn an undifferentiated grid of +/− into three labelled
  // controls you can find without re-reading the message.
  return Markup.inlineKeyboard([
    [Markup.button.callback("🎟 Quantity per wallet", "mint:noop")],
    [
      Markup.button.callback("−", "mint:qty:-1"),
      Markup.button.callback(`✅ ${config.quantity}`, "mint:noop"),
      Markup.button.callback(atMax ? "•" : "+", atMax ? "mint:noop" : "mint:qty:1"),
      Markup.button.callback(max ? `Max (${max})` : "Max", "mint:qty:max"),
    ],
    [Markup.button.callback("💼 Number of wallets", "mint:noop")],
    [
      Markup.button.callback("−", "mint:wal:-1"),
      Markup.button.callback(`✅ ${config.wallets}`, "mint:noop"),
      Markup.button.callback(config.wallets >= walletsAvailable ? "•" : "+", config.wallets >= walletsAvailable ? "mint:noop" : "mint:wal:1"),
    ],
    [Markup.button.callback("💰 Mint price override", "mint:noop")],
    [
      Markup.button.callback("−0.01", "mint:px:-10000000000000000"),
      Markup.button.callback("−0.001", "mint:px:-1000000000000000"),
      Markup.button.callback(config.priceOverrideWei != null ? "↺ contract" : "💰 —", "mint:px:clear"),
      Markup.button.callback("+0.001", "mint:px:1000000000000000"),
      Markup.button.callback("+0.01", "mint:px:10000000000000000"),
    ],
    [Markup.button.callback(`🚀 CONFIRM MINT (${total} total)`, "mint:confirm")],
    [Markup.button.callback("🧹 SWEEP MINT (max allowed)", "mint:sweep")],
    [Markup.button.callback("🔍 Check wallet eligibility", "mint:eligibility")],
    [Markup.button.callback("⏰ Schedule auto-mint when live", "mint:schedule")],
    [Markup.button.callback("🔄 Refresh", "mint:refresh"), Markup.button.callback("🔙 Menu", "menu:home")],
  ]);
}

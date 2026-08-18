import { Markup } from "telegraf";
import { formatEther } from "ethers";
import { totalCostWei } from "../mint/mintSession.js";
import { countMintWallets } from "../mint/mintWallets.js";

// The mint configuration keyboard.
//
// Every number shown here comes from the contract, not from a default. "Max
// (3)" is getPublicDrop's maxTotalMintableByWallet for this collection; the
// price is its mintPrice. A control that displays a plausible-looking number
// it did not read is worse than no control, because it will be trusted.
const fmt = (wei) => (wei == null ? "unknown" : `${Number(formatEther(wei))}`);

export function buildMintConfigText(config) {
  const { detect } = config;
  const unit = config.priceOverrideWei ?? detect.phase?.priceWei ?? null;
  const total = totalCostWei(config);
  const walletsAvailable = countMintWallets();

  const lines = [
    `⚙️ *Configure mint — ${detect.name || "collection"}*`,
    "",
    `• Per wallet: *${config.quantity}*${detect.phase?.maxPerWallet ? ` of max ${detect.phase.maxPerWallet}` : ""}`,
    `• Wallets: *${config.wallets}*${walletsAvailable ? ` of ${walletsAvailable} loaded` : " — none loaded"}`,
    `• Price each: *${fmt(unit)} ETH*${config.priceOverrideWei != null ? " _(override)_" : " _(from contract)_"}`,
    `• Total: *${total == null ? "unknown" : `${Number(formatEther(total))} ETH`}*` +
      `${detect.phase?.feeBps ? ` _(incl. ${detect.phase.feeBps / 100}% marketplace fee)_` : ""}`,
  ];

  // State that would stop the mint belongs above the buttons, not behind
  // them. Someone about to tap CONFIRM should already know it cannot work.
  const blockers = [];
  if (detect.soldOut) blockers.push("sold out");
  if (detect.mintable === false && !detect.soldOut) blockers.push("phase not open");
  if (walletsAvailable === 0) blockers.push("no wallets loaded");
  if (unit == null) blockers.push("price unknown");
  if (blockers.length) lines.push("", `⛔️ *Cannot mint:* ${blockers.join(", ")}`);

  return lines.join("\n");
}

export function mintConfigKeyboard(config) {
  const { detect } = config;
  const max = detect.phase?.maxPerWallet ?? null;
  const walletsAvailable = countMintWallets();
  const atMax = max != null && config.quantity >= max;

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
    [Markup.button.callback("💰 Price override", "mint:noop")],
    [
      Markup.button.callback("-0.01", "mint:px:-10000000000000000"),
      Markup.button.callback("-0.001", "mint:px:-1000000000000000"),
      Markup.button.callback(config.priceOverrideWei != null ? "↺ contract" : "💰 —", "mint:px:clear"),
      Markup.button.callback("+0.001", "mint:px:1000000000000000"),
      Markup.button.callback("+0.01", "mint:px:10000000000000000"),
    ],
    [Markup.button.callback(`🚀 CONFIRM MINT (${config.quantity * Math.max(config.wallets, 1)} total)`, "mint:confirm")],
    [Markup.button.callback("🧹 SWEEP MINT (max allowed)", "mint:sweep")],
    [Markup.button.callback("🔍 Check wallet eligibility", "mint:eligibility")],
    [Markup.button.callback("⏰ Schedule auto-mint when live", "mint:schedule")],
    [Markup.button.callback("🔙 Menu", "menu:home")],
  ]);
}

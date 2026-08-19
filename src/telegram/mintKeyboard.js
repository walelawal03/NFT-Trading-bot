import { Markup } from "telegraf";
import { formatEther } from "ethers";
import { totalCostWei } from "../mint/mintSession.js";
import { countMintWallets } from "../mint/mintWallets.js";
import { explorerUrlFor } from "./formatMessage.js";
import { openseaChainSlug } from "../risk/opensea.js";
import { usdSuffix } from "../mint/nativePrice.js";

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

// Trims float noise without hiding small numbers. A 24h volume of
// 1.0954746427387252 is a float artefact rendered as precision nobody asked
// for; a floor of 0.000042 still needs its digits.
const eth = (n) => (n == null ? "?" : n >= 0.01 ? n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : Number(n.toPrecision(3)).toString());

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
  const totalEth = total == null ? null : Number(formatEther(total));
  const balEth = config.walletBalanceWei == null ? null : Number(formatEther(config.walletBalanceWei));

  lines.push(
    "",
    "⚙️ *Your mint*",
    `• ${config.quantity} per wallet × ${wallets} wallet${wallets === 1 ? "" : "s"} = *${config.quantity * wallets} total*`,
    `• Cost: *${totalEth == null ? "unknown" : `${totalEth} ETH`}*${totalEth == null ? "" : usdSuffix(totalEth, config.ethUsd)}` +
      `${config.priceOverrideWei != null ? " _(price overridden)_" : ""}`
  );

  // Balance next to cost, because "0.03 ETH" means nothing until you know
  // whether you hold it. Only the first wallet's balance — the roster screen
  // is where the full set lives, and a mint card listing twenty balances
  // would bury the controls it exists to present.
  if (balEth != null) {
    // Compare against cost PLUS gas, not cost alone. A balance of 0.00051
    // against a 0.0005 mint looks fine and is not: the transaction still has
    // to pay for itself, and that mint failed for want of 0.47 microether.
    // The reserve is a rough ceiling for one mint on these chains, deliberate
    // in being generous — telling someone to top up costs them nothing, and
    // a failed mint costs them the drop.
    const GAS_RESERVE_ETH = 0.00001;
    const short = totalEth != null && balEth < totalEth + GAS_RESERVE_ETH;
    // usdSuffix renders 0 as "(free)", which is right for a cost and absurd
    // for a balance — an empty wallet is not free, it is empty.
    const balUsd = balEth > 0 ? usdSuffix(balEth, config.ethUsd) : "";
    lines.push(`• Wallet: ${balEth.toFixed(6)} ETH${balUsd}${short ? " ⚠️ *not enough once gas is counted*" : ""}`);
  }
  lines.push(`• Wallets loaded: ${walletsAvailable}`);

  // Market data, when the collection has traded enough to have any. A drop
  // minutes old has none of this and the section simply does not appear —
  // showing "floor: unknown" on something that has never had a floor is
  // noise, not information.
  const s = config.stats;
  const hasMarket = s && (s.floorPriceEth != null || s.volume24hEth != null || s.numOwners != null);
  if (hasMarket) {
    lines.push("", "📊 *Market*");
    if (s.floorPriceEth != null) lines.push(`• Floor: *${eth(s.floorPriceEth)} ETH*${usdSuffix(s.floorPriceEth, config.ethUsd)}`);
    if (s.volume24hEth != null) lines.push(`• 24h volume: ${eth(s.volume24hEth)} ETH${usdSuffix(s.volume24hEth, config.ethUsd)}`);
    if (s.numOwners != null) lines.push(`• Owners: ${s.numOwners}${s.totalSales != null ? ` · ${s.totalSales} sales` : ""}`);
  }

  // The cheapest listing is what you would actually pay, which is not always
  // the floor OpenSea reports — the floor is a statistic, this is an order
  // that exists right now and can be filled.
  if (config.listing?.priceEth != null) {
    lines.push(
      "",
      `🛒 *Cheapest listing: ${eth(config.listing.priceEth)} ETH*${usdSuffix(config.listing.priceEth, config.ethUsd)}` +
        `${config.listing.tokenId ? ` — #${config.listing.tokenId}` : ""}`
    );
  }

  // Anything that would stop the mint goes ABOVE the buttons. Someone about
  // to tap CONFIRM should already know it cannot work.
  const blockers = [];
  if (detect.soldOut) blockers.push("sold out");
  if (detect.mintable === false && !detect.soldOut) blockers.push("phase not open");
  if (walletsAvailable === 0) blockers.push("no wallets loaded");
  if (unit == null) blockers.push("price unknown");
  if (blockers.length) lines.push("", `⛔️ *Can't mint:* ${blockers.join(", ")}`);

  const explorer = explorerUrlFor(chain.key, contractAddress);
  lines.push(
    "",
    `\`${contractAddress}\``,
    [`[OpenSea](${openseaUrlFor(config)})`, explorer && `[Explorer](${explorer})`].filter(Boolean).join("  ·  ")
  );

  return lines.join("\n");
}

// The collection page when the slug is known, the asset path otherwise. The
// slug URL is the one that previews properly — image, floor, item count —
// which is the whole reason to resolve it.
export function openseaUrlFor(config) {
  return config.openseaSlug
    ? `https://opensea.io/collection/${config.openseaSlug}`
    : `https://opensea.io/assets/${openseaChainSlug(config.chain.key)}/${config.contractAddress}`;
}

/**
 * Preview options for the mint card.
 *
 * Telegram previews the FIRST link it finds unless told otherwise, which
 * meant the explorer — a wall of grey text that pushed the mint buttons off
 * the bottom of a phone screen. Naming the URL explicitly picks the OpenSea
 * card instead: image, floor price, item count, the thing actually worth
 * looking at.
 *
 * show_above_text puts it above the details rather than between them and the
 * keyboard, so the controls stay directly under the numbers they act on.
 */
export function mintCardExtra(config) {
  return {
    parse_mode: "Markdown",
    link_preview_options: {
      url: openseaUrlFor(config),
      prefer_large_media: true,
      show_above_text: true,
    },
  };
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
      // Caps run to 60 and beyond on these drops. A stepper alone means
      // tapping "−" fifty-nine times to get from the cap to 1, which is not a
      // control, it is a punishment.
      Markup.button.callback("⌨️", "mint:qty:type"),
    ],
    [Markup.button.callback("💼 Number of wallets", "mint:noop")],
    [
      Markup.button.callback("−", "mint:wal:-1"),
      Markup.button.callback(`✅ ${config.wallets}`, "mint:noop"),
      Markup.button.callback(config.wallets >= walletsAvailable ? "•" : "+", config.wallets >= walletsAvailable ? "mint:noop" : "mint:wal:1"),
      Markup.button.callback("⌨️", "mint:wal:type"),
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

/**
 * Controls for a collection whose mint is over.
 *
 * "Too late" is not a useful answer on its own. Once minting has finished the
 * secondary market IS the way in, so the same card that reports the mint
 * closed also offers to fill the cheapest listing.
 *
 * Buying is offered only when a real order exists. A button that opens a flow
 * ending in "there is nothing to buy" wastes the tap and the round trip.
 */
export function secondaryKeyboard(config) {
  const rows = [];
  if (config.listing?.priceEth != null) {
    rows.push([Markup.button.callback(`🛒 BUY floor — ${eth(config.listing.priceEth)} ETH`, "mint:buyfloor")]);
  }
  rows.push([Markup.button.callback("🔄 Refresh", "mint:refresh"), Markup.button.callback("🔙 Menu", "menu:home")]);
  return Markup.inlineKeyboard(rows);
}

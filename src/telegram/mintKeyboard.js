import { Markup } from "telegraf";
import { formatEther } from "ethers";
import { effectiveWalletCount, selectedWalletAddresses, totalCostWei } from "../mint/mintSession.js";
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

function mintStatusLine(detect) {
  if (!detect.checked) return `⚪️ READ FAILED · ${detect.reason || "Could not read this contract"}`;
  if (detect.soldOut) return "🔴 SOLD OUT";
  if (detect.mintable === true) return "🟢 MINTING NOW";
  if (detect.phase?.startsAt && detect.phase.startsAt.getTime() > Date.now()) return "🕒 NOT OPEN YET";
  if (!detect.mintVia) return "🔴 NO RECOGNISED MINT ENTRYPOINT";
  if (detect.mintable === false) return "🔴 NOT MINTABLE";
  return "⚪️ STATE UNKNOWN";
}

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
  const selected = selectedWalletAddresses(config);
  const walletCount = effectiveWalletCount(config);

  const state = mintStatusLine(detect);

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
  if (!detect.checked && detect.reason) {
    lines.push(`• Read issue: ${detect.reason}`);
  }

  const totalEth = total == null ? null : Number(formatEther(total));
  const balEth = config.walletBalanceWei == null ? null : Number(formatEther(config.walletBalanceWei));

  lines.push(
    "",
    "⚙️ *Your mint*",
    selected?.length
      ? `• ${config.quantity} per wallet × *${walletCount} selected wallet${walletCount === 1 ? "" : "s"}* = *${config.quantity * walletCount} total*`
      : `• ${config.quantity} per wallet × ${walletCount} wallet${walletCount === 1 ? "" : "s"} = *${config.quantity * walletCount} total*`,
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
  if (selected?.length) {
    lines.push(`• Wallets: exact selection of ${selected.length}`);
  } else {
    lines.push(`• Wallets: first ${walletCount} wallet${walletCount === 1 ? "" : "s"} in roster order`);
  }
  lines.push(`• Wallets loaded: ${walletsAvailable}`);

  if (Array.isArray(config.walletEligibility) && config.walletEligibility.length) {
    const eligible = config.walletEligibility.filter((r) => r.ok).length;
    lines.push("", `🔍 *Eligible wallets* (${eligible}/${config.walletEligibility.length})`);
    const renderOne = (r) => {
      const bal = r.balance == null ? "?" : `${Number(formatEther(r.balance)).toFixed(5)} ETH`;
      const minted = r.minted == null ? "" : ` · minted ${r.minted}`;
      const allowance = r.remaining == null ? "" : ` · ${r.remaining} left`;
      const suffix = r.ok ? "" : ` · ${String(r.reason || "would revert").slice(0, 60)}`;
      return `${r.ok ? "✅" : "❌"} \`${r.address.slice(0, 10)}…\` ${bal}${minted}${allowance}${suffix}`;
    };
    const rows = config.walletEligibility.slice(0, 6).map(renderOne);
    lines.push(...rows);
    if (config.walletEligibility.length > rows.length) {
      lines.push(`…and ${config.walletEligibility.length - rows.length} more`);
    }
  }

  // Market data, when the collection has traded enough to have any. A drop
  // minutes old has none of this and the section simply does not appear —
  // showing "floor: unknown" on something that has never had a floor is
  // noise, not information.
  const s = config.stats;
  // Zero is absence, not a value, and usdSuffix renders it as "(free)" — so
  // an unsold drop was reporting "Floor: 0 ETH (free)" and "24h volume: 0 ETH
  // (free)", which reads as a price rather than as the silence it is. Same
  // guard, same reason, as the mint result card and the list-at-floor button:
  // a zero floor is what OpenSea returns when nothing is listed.
  const floor = s?.floorPriceEth > 0 ? s.floorPriceEth : null;
  const vol24h = s?.volume24hEth > 0 ? s.volume24hEth : null;
  const hasMarket = s && (floor != null || vol24h != null || s.numOwners != null);
  if (hasMarket) {
    lines.push("", "📊 *Market*");
    if (floor != null) lines.push(`• Floor: *${eth(floor)} ETH*${usdSuffix(floor, config.ethUsd)}`);
    if (vol24h != null) lines.push(`• 24h volume: ${eth(vol24h)} ETH${usdSuffix(vol24h, config.ethUsd)}`);
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

  // The exit check. Placed directly above the blockers and the buttons,
  // because "can I get out" is the question a mint card otherwise never
  // answers — and by the time it matters, it is too late to ask.
  const exit = config.roundTrip;
  if (exit) {
    if (exit.exitable === true) {
      lines.push("", "🔓 *Exit verified* — simulated mint, approve and sale-path transfer all succeeded");
    } else if (exit.exitable === false) {
      lines.push("", `🔒 *EXIT BLOCKED* — ${exit.reason}`);
    } else if (exit.verdict !== "MINT_FAILED") {
      // Unknown is stated, never omitted. A silent absence reads as a pass.
      lines.push("", `❓ _Exit not verified: ${exit.reason}_`);
    }
  }

  // Anything that would stop the mint goes ABOVE the buttons. Someone about
  // to tap CONFIRM should already know it cannot work.
  const blockers = [];
  if (!detect.checked) blockers.push("contract read failed");
  if (detect.soldOut) blockers.push("sold out");
  if (detect.mintable === false && !detect.soldOut && detect.phase?.startsAt && detect.phase.startsAt.getTime() > Date.now()) blockers.push("not open yet");
  if (detect.mintable === false && !detect.soldOut && !detect.phase?.startsAt && detect.mintVia) blockers.push("phase not open");
  if (detect.mintVia == null) blockers.push("no recognised mint entrypoint");
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
  const total = config.quantity * effectiveWalletCount(config);
  const selected = selectedWalletAddresses(config);
  const walletCount = effectiveWalletCount(config);

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
    [Markup.button.callback("💼 Wallet selection", "mint:noop")],
    ...(walletsAvailable
      ? [[
          Markup.button.callback("1", "mint:wallets:first:1"),
          Markup.button.callback("2", "mint:wallets:first:2"),
          Markup.button.callback("3", "mint:wallets:first:3"),
          Markup.button.callback("4", "mint:wallets:first:4"),
          Markup.button.callback("All", "mint:wallets:all"),
        ]]
      : []),
    [
      Markup.button.callback("−", "mint:wal:-1"),
      Markup.button.callback(selected?.length ? `✅ ${selected.length} selected` : `✅ ${config.wallets}`, "mint:noop"),
      Markup.button.callback(config.wallets >= walletsAvailable && !selected?.length ? "•" : "+", config.wallets >= walletsAvailable && !selected?.length ? "mint:noop" : "mint:wal:1"),
      Markup.button.callback("⌨️", "mint:wal:type"),
      Markup.button.callback("🎯", "mint:wallets:choose"),
    ],
    ...(selected?.length ? [[Markup.button.callback("↩ Use first N wallets", "mint:wallets:clear")]] : []),
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

/**
 * What you own after a mint, what it is worth, and how to sell it.
 *
 * The floor is the only price signal available immediately after a mint —
 * your specific token has no bid — so it is shown as an indication and
 * labelled as one. A mint that cost gas and sits below floor is still a
 * position worth seeing honestly rather than a number massaged upward.
 */
export function buildMintResultText({ result, chain, contractAddress, stats, ethUsd, listing }) {
  if (result.pending) {
    return [`⏳ *Mint sent, not yet confirmed*`, "", `\`${result.txHash}\``, "", result.reason].join("\n");
  }
  if (!result.ok) {
    return [`❌ *Mint failed on-chain*`, "", `\`${result.txHash}\``, "", result.reason].join("\n");
  }

  // A floor of 0 is not a price — it is what OpenSea reports when nothing is
  // listed. Treating it as one would price a sale at zero, which is giving
  // the token away. Anything non-positive is "no floor".
  const rawFloor = stats?.floorPriceEth ?? null;
  const floor = rawFloor != null && rawFloor > 0 ? rawFloor : null;
  const owned = result.balance ?? result.tokenIds.length;
  const lines = [
    `✅ *Minted ${result.tokenIds.length} × ${result.name || "NFT"}*`,
    result.tokenIds.length ? `${result.tokenIds.map((id) => `#${id}`).join(", ")}` : "",
    "",
    `• You now hold: *${owned}*`,
    `• Gas paid: ${eth(result.gasCostEth)} ETH${usdSuffix(result.gasCostEth, ethUsd)}`,
  ];

  if (floor != null) {
    lines.push(
      `• Floor: *${eth(floor)} ETH*${usdSuffix(floor, ethUsd)} each`,
      `• Position at floor: *${eth(floor * owned)} ETH*${usdSuffix(floor * owned, ethUsd)}`
    );
  } else {
    // No floor yet is the normal state for a drop that just minted, and
    // saying so beats an empty space that looks like a missing feature.
    lines.push("• No floor yet — nothing has resold on the secondary market");
  }

  if (listing?.priceEth != null) lines.push(`• Cheapest listing right now: ${eth(listing.priceEth)} ETH`);

  lines.push("", `\`${result.txHash}\``);
  return lines.filter((l) => l != null).join("\n");
}

/**
 * Controls after a mint. Selling is offered only when there is a floor to
 * price against — a "sell at floor" button on a collection with no floor
 * would have to invent the number it sells at.
 */
export function mintResultKeyboard({ result, stats }) {
  const rows = [];
  // Same guard as the text: a zero floor cannot price a sale, so no sell
  // button is offered rather than one that would list at nothing.
  const raw = stats?.floorPriceEth ?? null;
  const floor = raw != null && raw > 0 ? raw : null;
  if (result.ok && floor != null && result.tokenIds?.length) {
    rows.push([Markup.button.callback(`🏷 List all at floor (${eth(floor)} ETH)`, "mint:sellfloor")]);
    rows.push([Markup.button.callback(`🏷 List at floor +10%`, "mint:sellfloor:110")]);
  }
  rows.push([Markup.button.callback("🔄 Refresh", "mint:refresh"), Markup.button.callback("🔙 Menu", "menu:home")]);
  return Markup.inlineKeyboard(rows);
}

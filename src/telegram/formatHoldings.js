import { Markup } from "telegraf";
import { openseaChainSlug } from "../risk/opensea.js";
import { explorerUrlFor, escapeMd } from "./formatMessage.js";
import { usdSuffix } from "../mint/nativePrice.js";

// The holdings view: what the mint wallets own, what it is worth, where to
// look at it.
//
// Pure rendering — every number here was already decided by
// mint/nftHoldings.js. Nothing in this file reads a chain or an API, so the
// pathological cases (a wallet holding hundreds, a collection with no name)
// can be tested offline.

// Same trimming as the mint card: hides float noise without hiding small
// numbers, because a floor of 0.000042 still needs its digits.
const eth = (n) =>
  n == null ? "?" : n >= 0.01 ? n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "") : Number(n.toPrecision(3)).toString();

// Floors that are already denominated in dollars.
//
// USDG is Robinhood Chain's own stablecoin and the common listing currency
// there — two of the three collections in the first real wallet were priced
// in it. The first version of this fix correctly stopped reading 1 USDG as
// 1 ETH, and then reported the collection as "not counted", which is a
// technically-true answer to a question nobody asked: the holder wants to
// know what their NFTs are worth, and one USDG is one dollar.
//
// Held at 1.0 rather than fetched. A stablecoin can depeg, but a depeg is a
// few percent and the alternative here was an error of 2,300x. If one of
// these ever breaks badly enough that a portfolio readout is misleading, that
// is a headline, not a rounding problem.
const USD_STABLECOINS = new Map([
  ["USDG", 1],
  ["USDC", 1],
  ["USDT", 1],
  ["DAI", 1],
  ["PYUSD", 1],
]);

/**
 * What one item of this collection is worth in dollars, or null if unknowable.
 *
 * The two paths are deliberately separate: an ETH floor needs a live ETH/USD
 * rate that may not have loaded, while a stablecoin floor needs nothing at
 * all and must still work when that rate is missing.
 */
function floorUsd(group, ethUsd) {
  if (group.floorEth != null) return ethUsd ? group.floorEth * ethUsd : null;
  const rate = group.floorSymbol ? USD_STABLECOINS.get(group.floorSymbol.toUpperCase()) : null;
  if (rate != null && group.floorRaw != null) return group.floorRaw * rate;
  return null;
}

const usd = (n) =>
  n == null
    ? null
    : n >= 1000
      ? `$${n.toFixed(0)}`
      : n >= 1
        ? `$${n.toFixed(2)}`
        : `$${n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "")}`;

// Telegram rejects the WHOLE message over 4096 characters, so the list is
// budgeted rather than trusted to be short. A fixed collection count is not
// enough on its own: collection names come from the contract and token id
// lists vary, so twelve collections can be 2k characters or 5k. The budget is
// checked as blocks are appended and the cut always lands on a collection
// boundary — a truncated token list reads as a bug, a stated "+3 more
// collections" reads as a limit.
const MAX_CHARS = 3800;
const MAX_COLLECTIONS_SHOWN = 12;
const MAX_TOKENS_PER_COLLECTION = 20;
const MAX_NAME_CHARS = 48;

export function openseaCollectionUrl(group) {
  return group.slug
    ? `https://opensea.io/collection/${group.slug}`
    : `https://opensea.io/assets/${openseaChainSlug(group.chainKey)}/${group.contractAddress}`;
}

export function openseaTokenUrl(group, tokenId) {
  return `https://opensea.io/assets/${openseaChainSlug(group.chainKey)}/${group.contractAddress}/${tokenId}`;
}

/**
 * Renders the whole holdings view.
 *
 * `partial: true` is stated out loud rather than smoothed over. A holdings
 * list that quietly omits what it could not verify is worse than one that
 * says so — the number you would act on would be wrong and look complete.
 */
export function buildHoldingsText({ holdings, ethUsd = null }) {
  const { wallets, groups, partial } = holdings;

  if (!wallets.length) {
    return [
      "🖼 *Your NFTs*",
      "",
      "No mint wallets yet. Add one from *Mint wallets* — generate a fresh burner or import a key — and anything it mints shows up here.",
    ].join("\n");
  }

  if (!groups.length) {
    return [
      "🖼 *Your NFTs*",
      "",
      `Nothing held yet across ${wallets.length} wallet${wallets.length === 1 ? "" : "s"}.`,
      "",
      ...wallets.map((w) => `• \`${w.address}\``),
      "",
      partial ? "⚠️ Some contracts wouldn't answer — this view may be incomplete. Refresh in a moment." : "Paste a contract or an OpenSea link to mint something.",
    ].join("\n");
  }

  const totalTokens = groups.reduce((n, g) => n + g.tokens.length, 0);

  // The total is in DOLLARS, not ether, because the holdings are not all
  // denominated in ether. Summing an ETH total and then footnoting "1 priced
  // in USDG, not counted" answers a different question from the one being
  // asked: what is this worth. Dollars is the only unit every floor can be
  // expressed in, so it is the unit the headline uses.
  //
  // Only priced collections contribute. A collection with no floor is worth
  // an unknown amount, not zero, and adding zero for it would understate the
  // total while looking precise.
  const valued = groups
    .map((g) => ({ g, usd: floorUsd(g, ethUsd) }))
    .filter((x) => x.usd != null);
  const totalUsd = valued.reduce((sum, x) => sum + x.usd * x.g.tokens.length, 0);
  // Still shown alongside, since the sell path prices in ETH and a holder
  // reasonably wants both.
  const ethGroups = groups.filter((g) => g.floorEth != null);
  const valueEth = ethGroups.reduce((sum, g) => sum + g.floorEth * g.tokens.length, 0);
  const unpriced = groups.length - valued.length;

  const lines = [
    `🖼 *Your NFTs — ${totalTokens} across ${groups.length} collection${groups.length === 1 ? "" : "s"}*`,
  ];

  // Anything with a floor at all, in any currency — distinct from `valued`,
  // which additionally requires that we can express it in dollars.
  const stableGroups = groups.filter((g) => g.floorEth == null && g.floorRaw != null && g.floorSymbol);
  const anyPriced = ethGroups.length > 0 || stableGroups.length > 0;
  const notPriced = groups.length - ethGroups.length - stableGroups.length;

  // Dollars lead ONLY when every priced collection can be expressed in them.
  // Otherwise the headline is a partial sum wearing a total's clothes: with no
  // ETH/USD rate loaded, a wallet holding 0.002 ETH and 1 USDG of floor
  // reported "Value at floor: $1.00 (0.002 ETH)", which reads as though the
  // ether were included in the dollar figure. It was not.
  const allPricedValued = valued.length === ethGroups.length + stableGroups.length;

  if (allPricedValued && valued.length && totalUsd > 0) {
    const ethPart = valueEth > 0 ? ` (${eth(valueEth)} ETH${ethGroups.length < valued.length ? " + stablecoin floors" : ""})` : "";
    lines.push(`Value at floor: *${usd(totalUsd)}*${ethPart}` + (unpriced ? ` _(${unpriced} unpriced)_` : ""));
  } else if (anyPriced) {
    // No ETH/USD rate loaded, so dollars are unavailable — fall back to the
    // ETH total rather than claiming there are no floor prices. Caught by the
    // existing tests, which render without a rate: leading with dollars made
    // a wallet with a known ETH floor report "nothing has resold yet".
    lines.push(
      `Value at floor: *${eth(valueEth)} ETH*` +
        (stableGroups.length ? ` _(+${stableGroups.length} priced in ${[...new Set(stableGroups.map((g) => g.floorSymbol))].join("/")})_` : "") +
        (notPriced ? ` _(${notPriced} unpriced)_` : "")
    );
  } else {
    lines.push("_No floor prices yet — nothing here has resold on the secondary market._");
  }

  let used = lines.join("\n").length;
  let shown = 0;

  for (const group of groups.slice(0, MAX_COLLECTIONS_SHOWN)) {
    const ids = group.tokens.slice(0, MAX_TOKENS_PER_COLLECTION).map((t) => `#${t.tokenId}`);
    const more = group.tokens.length - ids.length;
    const name = group.name ? escapeMd(group.name.slice(0, MAX_NAME_CHARS)) : "Unnamed collection";

    const block = [
      "",
      `*${name}* · ${group.tokens.length}× · ${group.chainKey}`,
      `${ids.join(", ")}${more > 0 ? ` +${more} more` : ""}`,
    ];

    const unit = floorUsd(group, ethUsd);
    if (group.floorEth != null) {
      const position = group.floorEth * group.tokens.length;
      block.push(
        `Floor ${eth(group.floorEth)} ETH${usdSuffix(group.floorEth, ethUsd)} · position ${eth(position)} ETH${usdSuffix(position, ethUsd)}`
      );
    } else if (group.floorRaw != null && group.floorSymbol) {
      // Priced, just not in ether. Showing this as "No floor yet" would hide a
      // real price; showing it as ETH valued one token at $2,340 instead of
      // $1. Its own currency plus dollars, which is what the holder wants.
      const pos = unit != null ? unit * group.tokens.length : null;
      const dollars = unit != null ? ` (~${usd(unit)}) · position ${usd(pos)}` : " · not convertible to a total";
      block.push(`Floor ${group.floorRaw} ${escapeMd(group.floorSymbol)}${dollars}`);
    } else {
      block.push("No floor yet");
    }

    const explorer = explorerUrlFor(group.chainKey, group.contractAddress);
    block.push(
      [`[OpenSea](${openseaCollectionUrl(group)})`, explorer && `[Explorer](${explorer})`].filter(Boolean).join("  ·  ")
    );

    const size = block.join("\n").length + 1;
    if (used + size > MAX_CHARS) break;
    used += size;
    shown++;
    lines.push(...block);
  }

  const hidden = groups.length - shown;
  if (hidden > 0) {
    lines.push("", `_+${hidden} more collection${hidden === 1 ? "" : "s"} not shown._`);
  }

  lines.push(
    "",
    `Held by: ${wallets.map((w) => `\`${w.address.slice(0, 8)}…\``).join(", ")}`
  );

  if (partial) {
    lines.push("⚠️ Some contracts wouldn't answer — this view may be incomplete.");
  }

  return lines.join("\n");
}

/**
 * Controls for the holdings view.
 *
 * A per-collection "list at floor" is only offered where a floor exists, for
 * the same reason the mint result card refuses one: with no floor, the button
 * would have to invent the price it sells at, and OpenSea reports 0 when
 * nothing is listed. Selling at zero is the one mistake here that cannot be
 * undone once someone fills it.
 */
// Six is a phone-screen limit, not a data limit: past that the keyboard
// scrolls and the Refresh/Menu row disappears below the fold.
const MAX_SELL_BUTTONS = 6;

export function holdingsKeyboard(holdings) {
  const rows = [];
  for (const [i, group] of holdings.groups.slice(0, MAX_COLLECTIONS_SHOWN).entries()) {
    if (group.floorEth == null) continue;
    if (rows.length >= MAX_SELL_BUTTONS) break;
    rows.push([
      Markup.button.callback(
        `🏷 List ${group.tokens.length}× ${(group.name || "collection").slice(0, 18)} @ ${eth(group.floorEth)}`,
        `hold:sell:${i}`
      ),
    ]);
  }
  rows.push([
    Markup.button.callback("🔄 Refresh", "hold:refresh"),
    Markup.button.callback("🔙 Menu", "menu:home"),
  ]);
  return Markup.inlineKeyboard(rows);
}

// The holdings message links to many collections; letting Telegram pick one
// to preview would be arbitrary. Previews off keeps the list readable.
export const holdingsExtra = { parse_mode: "Markdown", link_preview_options: { is_disabled: true } };


const explorerUrls = {
  ethereum: (addr) => `https://etherscan.io/token/${addr}`,
  base: (addr) => `https://basescan.org/token/${addr}`,
  bsc: (addr) => `https://bscscan.com/token/${addr}`,
  arbitrum: (addr) => `https://arbiscan.io/token/${addr}`,
  monad: (addr) => `https://monadvision.com/address/${addr}`,
  arc: (addr) => `https://arc-scan.org/address/${addr}`,
  // Robinhood Chain's official explorer — Blockscout-powered, confirmed live.
  robinhood: (addr) => `https://robinhoodchain.blockscout.com/address/${addr}`,
};

export function explorerUrlFor(chainKey, addr) {
  return explorerUrls[chainKey]?.(addr) || null;
}

const gradeEmoji = { A: "🟢", B: "🟩", C: "🟡", D: "🟠", F: "🔴" };

// Legacy Telegram Markdown treats _, *, `, [ as entity delimiters — an odd
// count of any of them (common in on-chain token symbols and raw error
// text, both outside our control) leaves an entity unclosed and Telegram
// rejects the whole message with "can't parse entities", silently dropping
// it. Escape before interpolating any attacker/environment-controlled text.
export function escapeMd(str) {
  if (!str) return str;
  return String(str).replace(/([_*`[])/g, "\\$1");
}

export function fmtUsd(n) {
  if (!n) return "$0";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${n.toFixed(2)}`;
}

const txExplorerUrls = {
  ethereum: (hash) => `https://etherscan.io/tx/${hash}`,
  base: (hash) => `https://basescan.org/tx/${hash}`,
  bsc: (hash) => `https://bscscan.com/tx/${hash}`,
  arbitrum: (hash) => `https://arbiscan.io/tx/${hash}`,
  monad: (hash) => `https://monadvision.com/tx/${hash}`,
  arc: (hash) => `https://arc-scan.org/tx/${hash}`,
  // Robinhood Chain's explorer used to be omitted here as unconfirmed, which
  // meant a real mint or sale on our primary target chain reported a bare tx
  // hash and no link. It is the same Blockscout instance the address links
  // above already use, and it has been confirmed live.
  robinhood: (hash) => `https://robinhoodchain.blockscout.com/tx/${hash}`,
};

// Floor price / owners / volume stand in for price / market cap / liquidity,
// and an extra "listed" state exists between open and closed that has no
// token-side equivalent, since exiting an NFT means creating a marketplace
// listing and waiting for a buyer rather than an instant swap.

function fmtEth(n) {
  if (n == null || !Number.isFinite(n)) return "n/a";
  if (n === 0) return "0 ETH";
  if (n < 0.0001) return `${n.toExponential(2)} ETH`;
  return `${n.toFixed(4)} ETH`;
}

export function buildNftCallMessage({ chain, contractAddress, riskResult, source, triggerWalletLabel }) {
  const { score, grade, label, breakdown, flags, name, slug, stats, totalSupply } = riskResult;
  const explorer = explorerUrlFor(chain.key, contractAddress);
  const openseaUrl = slug ? `https://opensea.io/collection/${slug}` : null;
  const sourceTag =
    source === "copy_trade" ? `👤 *Copy Signal* — ${escapeMd(triggerWalletLabel) || "a watched wallet"} just bought in` : "🆕 *New Collection*";

  // Where contract safety came from. At mint time this is usually the only
  // category carrying real information — marketplace liquidity and holder
  // distribution are structurally near-zero before a market exists — so the
  // reader should be able to see whether the 35 was earned by a scan that
  // succeeded or defaulted from one that didn't.
  const verdict = riskResult.contractVerdict;
  const scanTag = !verdict
    ? ""
    : verdict.fatal
      ? " 🚨 hard gate"
      : verdict.unknown
        ? " ⚪️ unreadable"
        : ` via \`${riskResult.contractScan?.proxy?.via ?? "direct"}\``;

  const lines = [
    `📣 *NEW NFT CALL* — ${escapeMd(name) || "Unknown"} on ${chain.label}`,
    sourceTag,
    "",
    `${gradeEmoji[grade]} *Risk Score: ${score}/100 — ${grade} (${label})*`,
    `  • Contract safety: ${breakdown.contractSafety}/35${scanTag}`,
    `  • Marketplace liquidity: ${breakdown.marketplaceLiquidity}/25`,
    `  • Holder distribution: ${breakdown.holderDistribution}/20`,
    `  • Deployer history: ${breakdown.deployerHistory}/20`,
    "",
    `💎 Floor: ${fmtEth(stats?.floorPriceEth)}`,
    `📊 24h Volume: ${fmtEth(stats?.volume24hEth)}`,
    `👥 Owners: ${stats?.numOwners ?? "n/a"}${totalSupply ? ` / ${totalSupply} supply` : ""}`,
  ];

  if (flags.length) {
    lines.push("", "⚠️ *Flags:*", ...flags.slice(0, 6).map((f) => `  • ${f}`));
  }

  lines.push(
    "",
    `\`${contractAddress}\``,
    [explorer && `[Explorer](${explorer})`, openseaUrl && `[OpenSea](${openseaUrl})`].filter(Boolean).join(" | ")
  );

  return lines.join("\n");
}

export function buildNftPaperTradeOpenMessage({ chain, contractAddress, name, tokenId, entryPriceEth, targetMultiple, stopFloorPct }) {
  return [
    `📝 *NFT paper trade opened* — ${escapeMd(name) || "Unknown"} #${tokenId} on ${chain.label}`,
    `Entry: ${fmtEth(entryPriceEth)}`,
    `Target: ${targetMultiple}x floor | Stop: ${stopFloorPct}% of entry`,
    "",
    `\`${contractAddress}\``,
  ].join("\n");
}

export function buildNftRealTradeOpenMessage({ chain, contractAddress, name, tokenId, entryPriceEth, targetMultiple, stopFloorPct, txHash, gasEth }) {
  const explorer = txExplorerUrls[chain.key]?.(txHash);
  return [
    `💰 *REAL NFT trade opened* — ${escapeMd(name) || "Unknown"} #${tokenId} on ${chain.label}`,
    `Entry: ${fmtEth(entryPriceEth)} | Gas: ${fmtEth(gasEth)}`,
    `Target: ${targetMultiple}x floor | Stop: ${stopFloorPct}% of entry`,
    "",
    `\`${contractAddress}\``,
    explorer ? `[Transaction](${explorer})` : `Tx: \`${txHash}\``,
  ].join("\n");
}

// "Listed for sale, waiting for a buyer" — a real intermediate state with no
// token-side equivalent (a token exit is one instant swap; an NFT exit is a
// marketplace order that may sit unfilled for a while, or never fill at the
// listed price).
export function buildNftListedMessage({ chain, contractAddress, name, tokenId, listedPriceEth, reason, mode = "paper" }) {
  const modeLabel = mode === "real" ? "REAL " : "";
  const reasonLabel = reason === "stop_floor" ? "stop-loss listing" : "take-profit listing";
  return [
    `🏷️ *${modeLabel}NFT listed for sale* (${reasonLabel})`,
    `${escapeMd(name) || "Unknown"} #${tokenId} on ${chain.label}`,
    `Listed at: ${fmtEth(listedPriceEth)}`,
    "⏳ Not a guaranteed or instant exit — this waits for a buyer on OpenSea.",
    "",
    `\`${contractAddress}\``,
  ].join("\n");
}

const NFT_CLOSE_HEADLINES = {
  take_profit_sold: "🎯 *NFT trade closed — SOLD at target*",
  stop_loss_sold: "🛑 *NFT trade closed — SOLD at stop*",
  manual_close: "🛑 *NFT trade closed — manual*",
};

export function buildNftPaperTradeCloseMessage({ chain, contractAddress, name, tokenId, entryPriceEth, exitPriceEth, pnlEth, pnlPct, exitReason }) {
  const won = pnlPct >= 0;
  const headline = NFT_CLOSE_HEADLINES[exitReason] || "⏱ *NFT paper trade closed*";
  return [
    headline,
    `${escapeMd(name) || "Unknown"} #${tokenId} on ${chain.label}`,
    `${won ? "🟢" : "🔴"} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlEth >= 0 ? "+" : ""}${fmtEth(Math.abs(pnlEth))})`,
    "",
    `Entry: ${fmtEth(entryPriceEth)} | Exit: ${fmtEth(exitPriceEth)}`,
    "",
    `\`${contractAddress}\``,
  ].join("\n");
}

export function buildNftRealTradeCloseMessage({ chain, contractAddress, name, tokenId, entryPriceEth, exitPriceEth, pnlEth, pnlPct, exitReason, txHash, gasEth }) {
  const won = pnlPct >= 0;
  const headline = (NFT_CLOSE_HEADLINES[exitReason] || "⏱ *NFT trade closed*").replace("NFT trade", "REAL NFT trade");
  const explorer = txExplorerUrls[chain.key]?.(txHash);
  return [
    headline,
    `${escapeMd(name) || "Unknown"} #${tokenId} on ${chain.label}`,
    `${won ? "🟢" : "🔴"} ${pnlPct >= 0 ? "+" : ""}${pnlPct.toFixed(1)}% (${pnlEth >= 0 ? "+" : ""}${fmtEth(Math.abs(pnlEth))})`,
    `Entry: ${fmtEth(entryPriceEth)} | Exit: ${fmtEth(exitPriceEth)} | Gas: ${fmtEth(gasEth)}`,
    "",
    `\`${contractAddress}\``,
    explorer ? `[Transaction](${explorer})` : `Tx: \`${txHash}\``,
  ].join("\n");
}

export function buildNftTradingSummary({ settings, stats, mode = "paper" }) {
  const modeLabel = mode === "real" ? "💰 *Real NFT Trading*" : "📈 *NFT Paper Trading*";
  const statusLabel = mode === "real" ? (settings.enabled ? "🔴 LIVE — real money" : "⚪️ off") : settings.enabled ? "🟢 running" : "⏸ paused";
  const lines = [
    modeLabel,
    "",
    `Status: ${statusLabel}`,
    `Budget: ${fmtEth(settings.totalBudgetEth)} total | ${fmtEth(settings.positionSizeEth)}/item`,
    `Target: ${settings.targetMultiple}x floor | Stop: ${settings.stopFloorPct}% of entry`,
    "⚠️ NFT exits list on OpenSea and wait for a buyer — not an instant swap like token trading.",
    "",
    `Open/listed positions: ${stats.openCount} (${fmtEth(stats.deployedEth)} deployed)`,
    `Closed trades: ${stats.closedCount}`,
  ];
  if (stats.closedCount > 0) {
    lines.push(`Win rate: ${(stats.winRate * 100).toFixed(1)}% (${stats.wins}/${stats.closedCount})`);
    lines.push(`Realized PnL: ${stats.totalPnlEth >= 0 ? "+" : ""}${fmtEth(Math.abs(stats.totalPnlEth))}`);
  }
  return lines.join("\n");
}

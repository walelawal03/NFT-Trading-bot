import { formatEther } from "ethers";
import { escapeMd, explorerUrlFor } from "./formatMessage.js";

// Renders a mint detection for Telegram.
//
// The ordering is deliberate and matches how a decision actually gets made:
// can I mint this at all, then what does it cost, then when, then what am I
// minting. A phone shows about six lines before the fold, so anything that
// could stop you belongs above it.

const fmtEth = (wei) => (wei == null ? "unknown" : `${Number(formatEther(wei))} ETH`);

function fmtWhen(date) {
  if (!date) return "unknown";
  const ms = date.getTime() - Date.now();
  const abs = Math.abs(ms);
  const mins = Math.round(abs / 60000);
  const hrs = Math.round(abs / 3600000);
  const days = Math.round(abs / 86400000);
  const rel = abs < 90 * 60000 ? `${mins}m` : abs < 48 * 3600000 ? `${hrs}h` : `${days}d`;
  return `${date.toISOString().replace("T", " ").slice(0, 19)} UTC (${ms > 0 ? `in ${rel}` : `${rel} ago`})`;
}

export function buildMintDetectMessage({ chain, contractAddress, detect }) {
  if (!detect.checked) {
    return [
      `⚪️ *MINT SCAN — UNREADABLE* on ${chain.label}`,
      "",
      escapeMd(detect.reason || "Could not read this contract."),
      "",
      "This is not a green light. Treated as unknown.",
    ].join("\n");
  }

  const title = escapeMd(detect.name || "Unknown collection");
  const supply =
    detect.totalSupply != null && detect.maxSupply != null
      ? `${detect.totalSupply} / ${detect.maxSupply}`
      : detect.totalSupply != null
        ? `${detect.totalSupply} / unknown`
        : "unknown";

  // The headline answers the only question that matters first.
  const head = detect.soldOut
    ? "🔴 *SOLD OUT*"
    : detect.mintable === true
      ? "🟢 *MINTING NOW*"
      : detect.phase?.startsAt && detect.phase.startsAt.getTime() > Date.now()
        ? "🕒 *NOT OPEN YET*"
        : detect.mintable === false
          ? "🔴 *NOT MINTABLE*"
          : "⚪️ *MINT STATE UNKNOWN*";

  const lines = [
    `🎯 *${title}*${detect.symbol ? ` (${escapeMd(detect.symbol)})` : ""} on ${chain.label}`,
    head,
    "",
    `• Standard: \`${detect.standard}\``,
    `• Supply: ${supply}`,
  ];

  if (detect.phase) {
    lines.push(
      // feeBps is a SPLIT of mintPrice, not a surcharge: SeaDrop requires
      // msg.value == quantity * mintPrice exactly. Showing "+10% fee" implied
      // the mint cost 10% more than it does.
      `• Price: ${fmtEth(detect.phase.priceWei)}${detect.phase.feeBps ? ` (${detect.phase.feeBps / 100}% of that is marketplace fee)` : ""}`,
      `• Max per wallet: ${detect.phase.maxPerWallet ?? "unknown"}`
    );
    if (detect.phase.startsAt) lines.push(`• Opens: ${fmtWhen(detect.phase.startsAt)}`);
    if (detect.phase.endsAt) lines.push(`• Closes: ${fmtWhen(detect.phase.endsAt)}`);
  } else {
    lines.push("• No public phase configured (allowlist-only, or not set up yet)");
  }

  if (detect.mintVia) {
    lines.push(
      "",
      `🛠 *How it mints*`,
      `\`${escapeMd(detect.mintVia.signature)}\``,
      `↳ to \`${detect.mintVia.target}\``,
      escapeMd(detect.mintVia.note)
    );
  } else {
    lines.push("", "🛠 No recognised mint entrypoint — this may be allowlist-only, or minted elsewhere.");
  }

  if (detect.proxy?.implementation) {
    lines.push("", `Proxy: \`${detect.proxy.via}\` → \`${detect.proxy.implementation}\``);
  }

  const explorer = explorerUrlFor(chain.key, contractAddress);
  lines.push("", `\`${contractAddress}\``);
  // null rather than "" — the join below keeps empty strings, because they
  // are the blank-line separators. Filtering on "" collapsed the whole
  // message into one dense block with no paragraphs.
  if (explorer) lines.push(`[Explorer](${explorer})`);

  // Read-only, and said plainly. Nothing here has been simulated and no
  // transaction has been sent — the numbers are what the contract reports,
  // not a promise the mint will succeed.
  lines.push("", "_Read-only: contract state, not a simulation._");

  // != null, NOT !== "". Empty strings are the blank-line separators between
  // sections; filtering them collapsed the whole message into one dense block.
  return lines.filter((l) => l != null).join("\n");
}

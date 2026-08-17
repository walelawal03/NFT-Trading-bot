import { escapeMd, explorerUrlFor } from "./formatMessage.js";

// Renders a capability scan for Telegram. Kept in its own file rather than
// added to formatMessage.js because it deliberately shares nothing with
// buildNftCallMessage: that one reports a market (floor, volume, owners),
// this one reports a contract, and the whole point of the scan is that it
// still says something when there is no market yet.
//
// The two are meant to be read together once the scan is wired into
// nftRisk.js — this is the standalone view, for /nftcheck.

const LEVEL_EMOJI = { low: "🟢", medium: "🟡", high: "🔴", unknown: "⚪️" };

// Telegram rejects the ENTIRE message over 4096 chars, so overflow isn't a
// cosmetic problem — the user gets an API error instead of a report, on
// exactly the contracts most worth reading about. Left some headroom.
const MAX_LEN = 3900;

// verdict.flags embed full selector arrays (assessNftContractRisk builds
// them with .join(", ") over the whole list), so one note on a contract
// with thirty transfer-lock functions is a paragraph on its own. Caught by
// a test that renders 180 selectors: the per-group caps held fine and the
// notes still pushed the message to 7139 chars.
function clip(str, max = 170) {
  const s = String(str);
  return s.length <= max ? s : s.slice(0, max - 1) + "…";
}

// Telegram caps a message at 4096 chars and a contract with a long selector
// list can genuinely produce more than that, so every group is capped. The
// count is always shown so a truncated list never reads as a short one.
function group(label, items, limit = 6) {
  if (!items || items.length === 0) return null;
  // escapeMd escapes backticks, so it must NOT be applied inside a code
  // span — it would emit a literal backslash. Selector signatures are
  // generated from our own tables, never user input, so they are safe raw.
  const shown = items.slice(0, limit).map((i) => `\`${i}\``).join(", ");
  const more = items.length > limit ? ` _(+${items.length - limit} more)_` : "";
  return `  • *${label}* (${items.length}): ${shown}${more}`;
}

export function buildNftScanMessage({ chain, contractAddress, scan, verdict, elapsedMs }) {
  const explorer = explorerUrlFor(chain.key, contractAddress);
  const lines = [];

  if (!scan.checked) {
    // The unknown case gets its own short message on purpose. Padding it
    // out to look like a real report is how "we couldn't check" starts
    // reading like "we checked and it's fine" at a glance on a phone.
    lines.push(
      `⚪️ *CONTRACT SCAN — UNKNOWN* on ${chain.label}`,
      "",
      scan.timedOut ? "Scan exceeded its time budget." : "Scan could not complete.",
      `_${escapeMd(String(scan.reason || "").slice(0, 200))}_`,
      "",
      `This is *not* a clean result. Treated as unknown and penalised ${verdict.deduction}/35.`,
      "",
      `\`${contractAddress}\``,
      explorer ? `[Explorer](${explorer})` : ""
    );
    return lines.filter((l) => l != null).join("\n");
  }

  const header = verdict.fatal
    ? "🚨 *CONTRACT SCAN — FATAL*"
    : verdict.unknown
      ? "⚪️ *CONTRACT SCAN — UNREADABLE*"
      : "✅ *CONTRACT SCAN — PASSES HARD GATE*";

  lines.push(`${header} on ${chain.label}`, "");

  if (verdict.fatal) {
    lines.push("*Mintable, but possibly not sellable.* Do not mint.", "");
  }

  lines.push(
    `📉 *Deduction: ${verdict.deduction}/35* (contract safety)`,
    `🔎 ${scan.selectorCount} selectors read via \`${scan.proxy.via}\`${scan.proxy.upgradeable ? " — *upgradeable*" : ""}`
  );
  if (scan.proxy.implementation) {
    lines.push(`   ↳ impl \`${scan.proxy.implementation}\``);
  }

  lines.push("", `${LEVEL_EMOJI[scan.metadata.level]} *Metadata: ${scan.metadata.level}* (${scan.metadata.scheme})`);
  lines.push(`  _${escapeMd(scan.metadata.reason)}_`);
  if (scan.metadata.uri) {
    lines.push(`  \`${scan.metadata.uri.slice(0, 80).replace(/`/g, "")}\``);
  }

  const groups = [
    group("Seizure", scan.seizure),
    group("Transfer lock", scan.transferLock),
    group("Supply control", scan.supplyControl),
    group("Price/royalty", scan.economicControl),
    group("Metadata setters", scan.metadataControl),
    group("Upgrade paths", scan.upgradeEntrypoints),
    group("Can freeze metadata ✅", scan.metadataFreeze),
  ].filter(Boolean);

  if (groups.length > 0) lines.push("", "*Capabilities found:*", ...groups);
  else lines.push("", "_No flagged capabilities found._");

  if (verdict.flags.length > 0) {
    lines.push("", "*Notes:*", ...verdict.flags.slice(0, 6).map((f) => `  • ${escapeMd(clip(f))}`));
  }

  lines.push(
    "",
    `_Static analysis: what the owner can do, not what they will. ${elapsedMs}ms._`,
    "",
    `\`${contractAddress}\``,
    explorer ? `[Explorer](${explorer})` : ""
  );

  const out = lines.filter((l) => l != null).join("\n");

  // Backstop. Every section is individually capped above, but a hard
  // ceiling here means no future addition can silently reintroduce the
  // overflow. Truncating mid-Markdown could leave an unbalanced marker, so
  // the tail is stripped of markers rather than cut blindly.
  if (out.length <= MAX_LEN) return out;
  return out.slice(0, MAX_LEN).replace(/[*_`]/g, "") + "\n\n_…truncated._";
}

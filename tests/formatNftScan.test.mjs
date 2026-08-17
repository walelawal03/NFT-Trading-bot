// Message-shape tests for the /nftcheck reply. No network, no bot — just
// checks the rendered Markdown is valid and can't be misread.
//
// Run: TELEGRAM_BOT_TOKEN=x TELEGRAM_CHAT_ID=1 node tests/formatNftScan.test.mjs
import assert from "node:assert";
import { buildNftScanMessage } from "../src/telegram/formatNftScan.js";
import { assessNftContractRisk } from "../src/risk/nftDangerousFunctions.js";

const chain = { key: "robinhood", label: "Robinhood Chain" };
const addr = "0x1234567890123456789012345678901234567890";
const base = {
  checked: true, timedOut: false,
  proxy: { via: "direct", implementation: null, upgradeable: false },
  seizure: [], transferLock: [], metadataControl: [], metadataFreeze: [],
  supplyControl: [], economicControl: [], upgradeEntrypoints: [], selectorCount: 54,
  metadata: { level: "low", scheme: "ipfs", uri: "ipfs://bafy/1.json", reason: "No URI setter found in bytecode" },
};
const render = (scan) =>
  buildNftScanMessage({ chain, contractAddress: addr, scan, verdict: assessNftContractRisk(scan), elapsedMs: 187 });

// Telegram's legacy Markdown parser rejects the whole message on an
// unbalanced marker, so a formatting slip means the user gets an API error
// instead of a report. Counting unescaped markers catches that offline.
function unescapedCount(s, ch) {
  let n = 0;
  for (let i = 0; i < s.length; i++) if (s[i] === ch && s[i - 1] !== "\\") n++;
  return n;
}

let pass = 0, fail = 0;
const t = (name, fn) => { try { fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

console.log("\nformatNftScan\n");

t("markdown markers balance across every message shape", () => {
  const shapes = [
    base,
    { ...base, seizure: ["seize(uint256)"], transferLock: ["pause()"],
      metadata: { level: "high", scheme: "http", uri: "https://x.io/1", reason: "Mutable URI setter AND metadata served from a centralised host" } },
    { ...base, checked: false, timedOut: true, reason: "Scan exceeded 8000ms budget at round trip 1", selectorCount: 0 },
    { ...base, checked: false, timedOut: false, reason: "server response 403 Forbidden", selectorCount: 0 },
    { ...base, proxy: { via: "beacon", implementation: "0xaaaa000000000000000000000000000000000001", upgradeable: true } },
  ];
  for (const s of shapes) {
    const m = render(s);
    for (const ch of ["*", "_", "`"]) {
      assert.equal(unescapedCount(m, ch) % 2, 0, `unbalanced ${ch} in:\n${m}`);
    }
  }
});

t("no literal backslash leaks into code spans", () => {
  const m = render({ ...base, supplyControl: ["devMint(uint256)", "setMaxSupply(uint256)"] });
  assert.ok(!m.includes("\\`"), "escapeMd was applied inside a code span");
});

t("blank-line separators survive rendering", () => {
  assert.ok(render(base).includes("\n\n"), "sections collapsed together");
});

t("an unknown scan never reads like a pass", () => {
  const m = render({ ...base, checked: false, timedOut: true, reason: "budget", selectorCount: 0 });
  assert.ok(!/PASSES|✅ \*CONTRACT/.test(m), "unknown message implies a pass");
  assert.ok(m.includes("not* a clean result") || m.includes("not a clean result"));
  assert.ok(m.length < 500, `unknown message is ${m.length} chars — should stay short and unmistakable`);
});

t("a fatal scan leads with the instruction, not the detail", () => {
  const m = render({ ...base, transferLock: ["pause()"] });
  assert.ok(m.startsWith("🚨"), "fatal must lead with the alarm");
  assert.ok(m.indexOf("Do not mint") < m.indexOf("Capabilities found"), "verdict must precede detail");
});

t("stays under Telegram's 4096 limit with a pathological contract", () => {
  const many = (n, p) => Array.from({ length: n }, (_, i) => `${p}${i}(uint256,address,bytes32)`);
  const m = render({
    ...base, selectorCount: 400,
    seizure: many(30, "seize"), transferLock: many(30, "lock"), metadataControl: many(30, "meta"),
    supplyControl: many(30, "supply"), economicControl: many(30, "econ"), upgradeEntrypoints: many(30, "upg"),
  });
  assert.ok(m.length < 4096, `message is ${m.length} chars`);
  assert.ok(m.includes("more)"), "truncation must be signalled, not silent");
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

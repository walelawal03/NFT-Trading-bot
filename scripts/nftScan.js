// Point the NFT capability scan at real contracts and print what it found.
// Read-only: no transactions, no wallet, no spending. Safe to run against
// anything.
//
//   node scripts/nftScan.js <chain> <address> [address...]
//   node scripts/nftScan.js robinhood 0xabc... 0xdef...
//   node scripts/nftScan.js base 0xabc...
//
// Optional:
//   BUDGET_MS=500 node scripts/nftScan.js base 0xabc...
//
// Run this BEFORE wiring the scan into nftRisk.js. The tables are tuned on
// reasoning, not on your chains' actual contract population — the only way
// to know whether the deductions are calibrated or whether some legitimate
// launchpad template trips a fatal flag is to point it at collections you
// already have an opinion about and check the output matches.
import { CHAINS } from "../src/chains.js";
import { detectNftDangerousFunctions, assessNftContractRisk } from "../src/risk/nftDangerousFunctions.js";

const [, , chainKey, ...addresses] = process.argv;

if (!chainKey || addresses.length === 0) {
  console.error("usage: node scripts/nftScan.js <chain> <address> [address...]");
  console.error(`chains: ${Object.keys(CHAINS).join(", ")}`);
  process.exit(1);
}

const chainDef = CHAINS[chainKey];
if (!chainDef) {
  console.error(`Unknown chain "${chainKey}". Known: ${Object.keys(CHAINS).join(", ")}`);
  process.exit(1);
}
const chain = { key: chainKey, ...chainDef };
const budgetMs = Number(process.env.BUDGET_MS || 5000);

const list = (label, arr) => {
  if (arr.length > 0) console.log(`  ${label.padEnd(20)} ${arr.join(", ")}`);
};

for (const address of addresses) {
  console.log(`\n${"─".repeat(72)}\n${address}  (${chainKey})`);

  const t0 = Date.now();
  const scan = await detectNftDangerousFunctions(chain, address, { budgetMs });
  const elapsed = Date.now() - t0;
  const verdict = assessNftContractRisk(scan);

  console.log(`  ${"scan".padEnd(20)} ${elapsed}ms, ${scan.selectorCount} selectors extracted`);

  if (!scan.checked) {
    console.log(`  ${"RESULT".padEnd(20)} UNKNOWN — ${scan.reason}`);
    console.log(`  ${"".padEnd(20)} (never treat this as clean: deduction ${verdict.deduction})`);
    continue;
  }

  console.log(
    `  ${"code".padEnd(20)} via ${scan.proxy.via}` +
      (scan.proxy.implementation ? ` → ${scan.proxy.implementation}` : "") +
      (scan.proxy.upgradeable ? "  [UPGRADEABLE]" : "")
  );
  console.log(`  ${"metadata".padEnd(20)} ${scan.metadata.level.toUpperCase()} (${scan.metadata.scheme}) — ${scan.metadata.reason}`);
  if (scan.metadata.uri) console.log(`  ${"uri".padEnd(20)} ${scan.metadata.uri.slice(0, 90)}`);

  list("seizure", scan.seizure);
  list("transfer lock", scan.transferLock);
  list("metadata control", scan.metadataControl);
  list("metadata freeze", scan.metadataFreeze);
  list("supply control", scan.supplyControl);
  list("economic control", scan.economicControl);
  list("upgrade paths", scan.upgradeEntrypoints);

  console.log(
    `\n  ${"VERDICT".padEnd(20)} ${verdict.fatal ? "🚨 FATAL — do not mint" : verdict.unknown ? "⚠️  UNKNOWN" : "✅ passes hard gate"}` +
      `   deduction ${verdict.deduction}/35`
  );
  for (const f of verdict.flags) console.log(`    · ${f}`);
}

console.log();

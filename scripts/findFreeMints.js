// Which drops can we actually mint right now, and which are free?
//
// Written for the latency experiment: measuring our send time against the
// live field needs a real drop that is open, has supply left, and costs
// nothing to enter. Reading the mint config of forty collections by hand
// through Telegram is not a workflow.
//
// Reads the collections the watcher has already called from the database and
// asks each contract directly what its mint config is — the same
// detectNftMint the mint card uses, so what this prints is exactly what the
// bot would do. No OpenSea on the path.
//
//   node scripts/findFreeMints.js                  # robinhood, 40 newest
//   node scripts/findFreeMints.js base 25
//
// Read-only. No wallet, no gas, no transaction.
import { formatEther } from "ethers";
import { CHAINS } from "../src/chains.js";
import { db } from "../src/store/db.js";
import { detectNftMint } from "../src/mint/nftMintDetect.js";

const chainKey = process.argv[2] || "robinhood";
const limit = Number(process.argv[3]) || 40;
// Robinhood's public RPC is slow and rate-limited enough that hammering it
// with forty concurrent multi-call detections gets a chunk of them timing out
// and reported as "couldn't read", which looks like a finding and is not one.
const CONCURRENCY = 4;

const chain = { key: chainKey, ...CHAINS[chainKey] };
if (!CHAINS[chainKey]) {
  console.error(`unknown chain: ${chainKey}`);
  process.exit(1);
}

const rows = db
  .prepare(
    `SELECT contract_address, name FROM called_nft_collections
     WHERE chain = ? ORDER BY called_at DESC LIMIT ?`
  )
  .all(chainKey, limit);

console.log(`\nChecking ${rows.length} ${chain.label} collections for an open mint…\n`);

async function check(row) {
  try {
    const d = await detectNftMint(chain, row.contract_address, { budgetMs: 12000 });
    return { row, d };
  } catch (err) {
    return { row, d: null, error: err.message };
  }
}

const results = [];
for (let i = 0; i < rows.length; i += CONCURRENCY) {
  const batch = rows.slice(i, i + CONCURRENCY);
  results.push(...(await Promise.all(batch.map(check))));
  process.stdout.write(`  ${Math.min(i + CONCURRENCY, rows.length)}/${rows.length}\r`);
}
console.log(" ".repeat(30));

const live = [];
const upcoming = [];
const closed = [];
const unreadable = [];

for (const { row, d, error } of results) {
  if (error || !d || d.checked === false) {
    unreadable.push({ row, reason: error || d?.reason || "unreadable" });
    continue;
  }
  const price = d.phase?.priceWei;
  const entry = {
    addr: row.contract_address,
    name: d.name || row.name || "?",
    standard: d.standard,
    priceWei: price,
    free: price === 0n,
    startsAt: d.phase?.startsAt ?? null,
    endsAt: d.phase?.endsAt ?? null,
    maxPerWallet: d.phase?.maxPerWallet ?? null,
    supply: d.totalSupply ?? null,
    maxSupply: d.maxSupply ?? null,
    soldOut: d.soldOut,
  };
  if (d.mintable) live.push(entry);
  else if (entry.startsAt && entry.startsAt.getTime() > Date.now()) upcoming.push(entry);
  else closed.push(entry);
}

const priceLabel = (p) => (p == null ? "price unknown" : p === 0n ? "FREE" : `${formatEther(p)} ETH`);
const supplyLabel = (e) =>
  e.supply != null ? `${e.supply}${e.maxSupply ? `/${e.maxSupply}` : ""} minted` : "supply unknown";

function show(title, list, extra = () => "") {
  console.log(`${"─".repeat(70)}`);
  console.log(`${title}  (${list.length})`);
  if (!list.length) console.log("  none");
  for (const e of list) {
    console.log(`  ${e.free ? "🆓" : "  "} ${e.name.slice(0, 34).padEnd(34)} ${priceLabel(e.priceWei).padEnd(14)} ${supplyLabel(e)}${extra(e)}`);
    console.log(`     ${e.addr}   ${e.standard}${e.maxPerWallet ? `, max ${e.maxPerWallet}/wallet` : ""}`);
  }
  console.log();
}

// Live and free is the target: open now, costs nothing to enter, so a timing
// run risks gas only.
show("OPEN NOW", live.sort((a, b) => Number(b.free) - Number(a.free)));
show("NOT OPEN YET — armable, and the only kind that tests the scheduler", upcoming, (e) =>
  `  opens ${e.startsAt.toISOString().replace("T", " ").slice(0, 19)}Z`
);
console.log(`${"─".repeat(70)}`);
console.log(`closed or sold out: ${closed.length}    unreadable: ${unreadable.length}`);
// Unreadable is not "no mint function" — this RPC times out often enough that
// a retry regularly turns an unknown into a perfectly ordinary drop.
if (unreadable.length) {
  console.log(`\nUnreadable (retry these, do not treat as findings):`);
  for (const u of unreadable.slice(0, 8)) console.log(`  ${u.row.contract_address}  ${u.reason.slice(0, 60)}`);
}
console.log();

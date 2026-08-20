// Where did we actually finish?
//
// This is the honest benchmark, and it exists because the obvious one is not
// available. Comparing this bot to morsyxbt/nft-public-mint or zunmax/osnm-z
// head-to-head would mean funding and configuring all three against the same
// drop at the same second. Nobody does that, and a synthetic comparison of
// "our send time vs their README" measures nothing.
//
// So instead: after a mint, read the chain. Every mint of an ERC-721 emits a
// Transfer from the zero address, so the full field is on-chain — every wallet
// that entered, in the exact order the sequencer accepted them. Our position
// in that ordering is our result against the REAL field, which already
// contains bots at least as good as those two, plus whoever else showed up.
//
// It answers the only question that matters: of everyone who wanted this
// drop, how many got in front of us, and by how much.
//
//   node scripts/mintPostMortem.js robinhood 0xCollection
//   node scripts/mintPostMortem.js robinhood 0xCollection 0xOurTxHash
//
// Read-only. No wallet, no gas, no transaction.
import { formatUnits, getAddress } from "ethers";
import { CHAINS } from "../src/chains.js";
import { getLogProvider, getProvider } from "../src/wallet.js";
import { detectNftMint } from "../src/mint/nftMintDetect.js";
import { listMintWallets } from "../src/mint/mintWallets.js";

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO_TOPIC = "0x" + "0".repeat(64);

// How far past the first mint to look. Robinhood is an Arbitrum Orbit chain
// with sub-second blocks, so this is seconds of real time, not minutes — and
// seconds is the entire duration of a mint race worth analysing.
const WINDOW_BLOCKS = 60;
// Fetching each competing transaction costs a round trip, and the answer is
// decided at the front of the queue. Beyond this we only count.
const DETAIL_LIMIT = 25;

const [chainKey, collectionArg, ourTxArg] = process.argv.slice(2);
if (!chainKey || !collectionArg) {
  console.error("usage: node scripts/mintPostMortem.js <chain> <collection> [ourTxHash]");
  process.exit(1);
}
if (!CHAINS[chainKey]) {
  console.error(`unknown chain: ${chainKey}`);
  process.exit(1);
}
const chain = { key: chainKey, ...CHAINS[chainKey] };
const collection = getAddress(collectionArg);
const logProvider = getLogProvider(chain);
const provider = getProvider(chain);

// Binary search rather than dividing by an assumed block time. Orbit chains
// do not have a fixed one — they produce a block per batch, so the interval
// moves with traffic, and "seconds since open / blockTime" lands nowhere near
// the right block on exactly the busy drops we care about.
async function blockAtOrAfter(timestampSec, hint) {
  let lo = 1;
  let hi = hint ?? (await provider.getBlockNumber());
  let answer = hi;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await provider.getBlock(mid);
    if (!b) break;
    if (b.timestamp >= timestampSec) {
      answer = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return answer;
}

const detect = await detectNftMint(chain, collection, { budgetMs: 15000 }).catch(() => null);
const openAt = detect?.phase?.startsAt ?? null;

let fromBlock;
let ourReceipt = null;
if (ourTxArg) {
  ourReceipt = await provider.getTransactionReceipt(ourTxArg);
  if (!ourReceipt) {
    console.error(`could not find transaction ${ourTxArg}`);
    process.exit(1);
  }
  // Start well before our own transaction: everyone who beat us is behind it,
  // and starting at our block would hide exactly the people we lost to.
  fromBlock = Math.max(1, ourReceipt.blockNumber - WINDOW_BLOCKS);
} else if (openAt) {
  fromBlock = await blockAtOrAfter(Math.floor(openAt.getTime() / 1000));
} else {
  console.error("no open time on this drop and no tx hash given — nothing to anchor the window to");
  process.exit(1);
}

const toBlock = fromBlock + WINDOW_BLOCKS * 2;
console.log(`\nMint post-mortem — ${detect?.name || collection}`);
console.log(`${chain.label}  ${collection}`);
if (openAt) console.log(`phase opened  ${openAt.toISOString().replace("T", " ").slice(0, 19)}Z`);
console.log(`scanning blocks ${fromBlock} → ${toBlock}\n`);

const logs = await logProvider.getLogs({
  address: collection,
  topics: [TRANSFER_TOPIC, ZERO_TOPIC], // from == 0x0 is a mint
  fromBlock,
  toBlock,
});

if (!logs.length) {
  console.log("No mints found in this window.");
  console.log("If the drop is ERC-1155 this is expected — it emits TransferSingle, not Transfer.\n");
  process.exit(0);
}

// One transaction can mint several tokens; the race is between TRANSACTIONS,
// not tokens, so collapse first and count quantity separately.
const byTx = new Map();
for (const log of logs) {
  const cur = byTx.get(log.transactionHash);
  if (cur) {
    cur.qty += 1;
    continue;
  }
  byTx.set(log.transactionHash, {
    hash: log.transactionHash,
    blockNumber: log.blockNumber,
    txIndex: log.transactionIndex,
    qty: 1,
    to: "0x" + log.topics[2].slice(26),
  });
}

// The sequencer's own ordering: block first, then position within the block.
// This IS the result — everything else on this page is explanation.
const race = [...byTx.values()].sort(
  (a, b) => a.blockNumber - b.blockNumber || a.txIndex - b.txIndex
);

const ourWallets = new Set(listMintWallets().map((w) => w.address.toLowerCase()));
if (ourReceipt) ourWallets.add(ourReceipt.from.toLowerCase());
const isOurs = (e) =>
  (ourTxArg && e.hash.toLowerCase() === ourTxArg.toLowerCase()) || ourWallets.has(e.to.toLowerCase());

const firstBlock = race[0].blockNumber;
const blockTimes = new Map();
for (const bn of new Set(race.slice(0, DETAIL_LIMIT).map((r) => r.blockNumber))) {
  const b = await provider.getBlock(bn).catch(() => null);
  if (b) blockTimes.set(bn, b.timestamp);
}

// Gas price is the other half of the story: losing to someone who outbid you
// is a different problem from losing to someone who was simply earlier, and
// they have different fixes.
const details = await Promise.all(
  race.slice(0, DETAIL_LIMIT).map(async (e) => {
    const tx = await provider.getTransaction(e.hash).catch(() => null);
    return { ...e, gasPriceGwei: tx?.gasPrice ? Number(formatUnits(tx.gasPrice, "gwei")) : null };
  })
);

console.log(`${race.length} minting transaction(s) in this window\n`);
console.log(`  #   block      idx  qty  gas(gwei)  since open   minter`);
console.log(`  ${"─".repeat(72)}`);

for (const [i, e] of details.entries()) {
  const ts = blockTimes.get(e.blockNumber);
  const since =
    ts != null && openAt ? `${(ts - Math.floor(openAt.getTime() / 1000)).toFixed(0)}s`.padStart(9) : "        —";
  const mark = isOurs(e) ? " <== US" : "";
  console.log(
    `  ${String(i + 1).padStart(3)}  ${String(e.blockNumber).padStart(9)}  ${String(e.txIndex).padStart(3)}  ` +
      `${String(e.qty).padStart(3)}  ${(e.gasPriceGwei?.toFixed(4) ?? "—").padStart(9)}  ${since}   ` +
      `${e.to.slice(0, 10)}…${mark}`
  );
}
if (race.length > DETAIL_LIMIT) console.log(`  … and ${race.length - DETAIL_LIMIT} more`);

const ourIndex = race.findIndex(isOurs);
console.log(`\n${"─".repeat(76)}`);
if (ourIndex === -1) {
  console.log(`We are not in this window.`);
  console.log(`Either we did not mint this drop, or we landed outside the ${WINDOW_BLOCKS * 2}-block scan.`);
} else {
  const us = race[ourIndex];
  const ahead = ourIndex;
  console.log(`WE FINISHED #${ourIndex + 1} of ${race.length}`);
  console.log(`  block ${us.blockNumber}, position ${us.txIndex} within that block`);
  console.log(`  ${ahead} transaction(s) got in ahead of us`);
  if (us.blockNumber === firstBlock) {
    // The important distinction. Landing in the first block means the network
    // race was won and only in-block ordering separated us — which is a fee
    // and sequencer-policy question, not a latency one, and no amount of
    // extra speed changes it.
    console.log(`\n  We made the FIRST block of the drop. Anyone ahead of us was ordered`);
    console.log(`  ahead within that same block — that is fee priority and sequencer`);
    console.log(`  policy, not latency. More speed would not have changed it.`);
  } else {
    const blocksLate = us.blockNumber - firstBlock;
    const t0 = blockTimes.get(firstBlock);
    const tu = blockTimes.get(us.blockNumber);
    const secsLate = t0 != null && tu != null ? tu - t0 : null;
    console.log(`\n  We were ${blocksLate} block(s) behind the first mint` + (secsLate != null ? `, about ${secsLate}s.` : "."));
    console.log(`  THIS is the latency gap, and it is the part hosting and the socket`);
    console.log(`  keep-alive actually move. Compare against scripts/rpcLatency.js on`);
    console.log(`  the same host to see how much of it is the network.`);
  }
}
console.log();

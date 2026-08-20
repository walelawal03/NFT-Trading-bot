// What is our actual floor, and where does it come from?
//
// nftMintExecutor.js says the fire path is one eth_sendRawTransaction that
// "measured 573ms at best on this endpoint. That round trip is the floor; no
// amount of preparation gets under it." That number is the single most
// important fact about whether this bot can compete, and it was measured from
// Lagos on a home connection. It is not a property of the code — it is a
// property of WHERE THE CODE RUNS. Move the process and the number moves.
//
// So this measures the floor properly, from wherever it is run, in a form
// that can be compared before and after a relocation. Run it locally, deploy,
// run it again on the host, and the difference is the entire value of hosting.
//
//   node scripts/rpcLatency.js               # every NFT chain
//   node scripts/rpcLatency.js robinhood     # one chain
//   node scripts/rpcLatency.js base 40       # one chain, 40 samples
//
// Read-only. Sends no transaction, needs no key, spends no gas.
import { CHAINS } from "../src/chains.js";
import { getNftChainKeys } from "../src/nftChains.js";
import { httpUrlsFor } from "../src/wallet.js";

const DEFAULT_SAMPLES = 25;

// Two different questions, and conflating them is how you end up "optimising"
// something that was never the cost:
//
//   cold — a brand new TCP + TLS connection every time. This is what the
//          FIRST request out of a freshly woken process pays, and a mint that
//          fires on a timer after minutes of idling is exactly that case if
//          the socket was allowed to die.
//   warm — an established keep-alive connection. This is the true floor, and
//          the number worth quoting, but ONLY if the bot actually holds the
//          socket open to fire time. morsy's bot warms sockets deliberately
//          for this reason; it is not an optimisation, it is the difference
//          between the two columns below.
const AGENTS = { warm: true, cold: false };

// eth_blockNumber is the smallest possible request: no params, tiny response.
// It isolates pure network round trip from anything the node has to compute,
// which is what we want — the mint's cost is the trip, not the work.
const PROBE = { jsonrpc: "2.0", id: 1, method: "eth_blockNumber", params: [] };

function stats(samples) {
  const ok = samples.filter((n) => Number.isFinite(n)).sort((a, b) => a - b);
  if (!ok.length) return null;
  const at = (p) => ok[Math.min(ok.length - 1, Math.floor((p / 100) * ok.length))];
  return {
    n: ok.length,
    lost: samples.length - ok.length,
    // min is the number that matters for a mint. A mint is one shot at one
    // moment; it does not get the median of many attempts, it gets whatever
    // the network gives it that instant. Median tells you the typical
    // experience, min tells you the best case the design can ever reach, and
    // p90 tells you what a bad instant costs.
    min: ok[0],
    median: at(50),
    p90: at(90),
    max: ok[ok.length - 1],
  };
}

async function sample(url, keepAlive) {
  // Node 22's global fetch, not ethers, and deliberately so: ethers adds its
  // own retry, batching and network-detection behaviour on top, which is the
  // right thing in production and the wrong thing when the question is "how
  // long does one packet round trip take".
  const t0 = performance.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", connection: keepAlive ? "keep-alive" : "close" },
      body: JSON.stringify(PROBE),
      signal: AbortSignal.timeout(10_000),
    });
    await res.text();
    if (!res.ok) return NaN;
    return performance.now() - t0;
  } catch {
    return NaN;
  }
}

async function measure(url, samples) {
  const out = {};
  for (const [label, keepAlive] of Object.entries(AGENTS)) {
    const runs = [];
    // One unmeasured request first, so the warm column measures a warm socket
    // rather than the handshake it would otherwise include — the exact mistake
    // that makes a keep-alive benchmark report cold numbers.
    if (keepAlive) await sample(url, true);
    for (let i = 0; i < samples; i++) runs.push(await sample(url, keepAlive));
    out[label] = stats(runs);
  }
  return out;
}

const fmt = (n) => (n == null ? "  —  " : `${n.toFixed(0).padStart(5)}`);

function renderRow(label, s) {
  if (!s) return `    ${label.padEnd(6)}  unreachable`;
  const lost = s.lost > 0 ? `  (${s.lost} lost)` : "";
  return `    ${label.padEnd(6)}${fmt(s.min)}${fmt(s.median)}${fmt(s.p90)}${fmt(s.max)}${lost}`;
}

const [chainArg, samplesArg] = process.argv.slice(2);
const samples = Number(samplesArg) || DEFAULT_SAMPLES;
const chainKeys = chainArg ? [chainArg] : getNftChainKeys();

console.log(`\nRPC round-trip latency — ${samples} samples per endpoint per mode`);
console.log(`Run at ${new Date().toISOString()}`);
console.log(`\nThe number that decides whether a mint competes is WARM MIN: it is the`);
console.log(`floor of the single eth_sendRawTransaction the fire path is reduced to.`);

const results = [];
for (const key of chainKeys) {
  const def = CHAINS[key];
  if (!def) {
    console.log(`\n${key}: unknown chain`);
    continue;
  }
  const chain = { key, ...def };
  const urls = httpUrlsFor(chain);
  console.log(`\n${"─".repeat(72)}`);
  console.log(`${def.label} (${key})`);
  console.log(`    mode      min   med   p90   max   (ms)`);
  for (const url of urls) {
    console.log(`  ${url}`);
    const m = await measure(url, samples);
    console.log(renderRow("warm", m.warm));
    console.log(renderRow("cold", m.cold));
    if (m.warm) results.push({ chain: key, url, warmMin: m.warm.min, warmMedian: m.warm.median });
  }
}

console.log(`\n${"─".repeat(72)}`);
console.log("BEST WARM MIN PER CHAIN — this is the floor to beat by relocating\n");
const byChain = new Map();
for (const r of results) {
  const cur = byChain.get(r.chain);
  if (!cur || r.warmMin < cur.warmMin) byChain.set(r.chain, r);
}
for (const [key, r] of byChain) {
  console.log(`  ${key.padEnd(10)} ${r.warmMin.toFixed(0).padStart(5)}ms   ${r.url}`);
}
// Context for whoever reads the output cold, so the number means something
// without having to go find the comment in nftMintExecutor.js.
console.log(`\n  For reference, the figure recorded in nftMintExecutor.js from Lagos on`);
console.log(`  a home connection was 573ms at best. A datacenter near the sequencer`);
console.log(`  should be a fraction of that; if it is not, the bottleneck is the`);
console.log(`  endpoint itself and no amount of relocating will fix it.\n`);

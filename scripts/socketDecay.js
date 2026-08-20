// Does the fire path pay for a dead socket?
//
// rpcLatency.js measured, against the same endpoint from the same machine:
// warm min 163ms, cold min 174ms, cold MEDIAN 493ms. So a handshake is not
// reliably expensive — it is expensive OFTEN, which is worse, because it
// makes the cost invisible until the one shot that matters.
//
// The scheduler prepares at T-90s and then goes silent until the phase opens.
// If the connection dies in that gap, every armed mint fires cold. The 573ms
// figure recorded in nftMintExecutor.js is what a cold fire looks like, so
// this is not a hypothetical.
//
// TWO METHODOLOGY TRAPS, both hit on the first version of this script and
// both worth naming, because either one produces a confident wrong answer:
//
//   1. provider.getBlockNumber() is CACHED by ethers. The first version
//      reported 0ms for a zero-idle call — a cache hit, not a network round
//      trip, which made the warm baseline meaninglessly fast and every idle
//      rung look like decay by comparison. Use provider.send() so the request
//      actually leaves the machine.
//   2. One sample per rung is noise. The first version produced 873ms at 10s
//      idle and 624ms at 60s — a decay curve that goes backwards is not a
//      decay curve. Each rung is repeated and reported as a MIN, which is
//      both the robust statistic here and the one that matters: a mint gets
//      one instant, and we want to know the best that instant can be.
//
//   node scripts/socketDecay.js
//
// Read-only. eth_blockNumber only. No key, no gas, no transaction.
import { CHAINS } from "../src/chains.js";
import { getNftChainKeys } from "../src/nftChains.js";
import { getProvider } from "../src/wallet.js";

// 30s and 90s bracket the scheduler's real idle gap (it prepares 90s ahead).
// 0s is the control: the same call with no silence before it.
const IDLE_LADDER_SEC = (process.argv[2] || "0,30,90").split(",").map(Number);
const REPS = 3;
const WARM_BASELINE_CALLS = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// provider.send(), NOT provider.getBlockNumber(). See trap 1 above.
async function timeOneCall(provider) {
  const t0 = performance.now();
  try {
    await provider.send("eth_blockNumber", []);
    return performance.now() - t0;
  } catch {
    return NaN;
  }
}

const min = (xs) => {
  const ok = xs.filter(Number.isFinite);
  return ok.length ? Math.min(...ok) : NaN;
};

async function measureChain(key) {
  const def = CHAINS[key];
  if (!def) return { key, error: "unknown chain" };
  const provider = getProvider({ key, ...def });

  // Back-to-back calls on an established connection. This is the floor the
  // fire path could reach if the socket were guaranteed alive.
  const warmRuns = [];
  for (let i = 0; i < WARM_BASELINE_CALLS; i++) warmRuns.push(await timeOneCall(provider));
  const warm = min(warmRuns);

  const rungs = [];
  for (const idle of IDLE_LADDER_SEC) {
    const samples = [];
    for (let r = 0; r < REPS; r++) {
      // Re-establish before each rep so every sample is genuinely "first call
      // after exactly this much silence".
      await timeOneCall(provider);
      await timeOneCall(provider);
      if (idle > 0) await sleep(idle * 1000);
      samples.push(await timeOneCall(provider));
    }
    rungs.push({ idle, ms: min(samples), samples });
  }
  return { key, label: def.label, warm, rungs };
}

console.log(`\nSocket decay — first call after N seconds of silence`);
console.log(`Run at ${new Date().toISOString()}`);
console.log(`${REPS} reps per rung, reported as min. Measured through the production`);
console.log(`provider via send(), so ethers' cache is bypassed and this is what an`);
console.log(`armed mint actually experiences.\n`);

// Chains run concurrently so the idle waits overlap rather than stack — one
// in-flight request each, so they do not meaningfully contend.
const results = await Promise.all(getNftChainKeys().map(measureChain));

for (const r of results) {
  console.log("─".repeat(64));
  if (r.error) {
    console.log(`${r.key}: ${r.error}`);
    continue;
  }
  console.log(`${r.label} (${r.key})`);
  console.log(`  warm baseline (back-to-back)   ${r.warm.toFixed(0).padStart(5)}ms`);
  for (const rung of r.rungs) {
    const delta = rung.ms - r.warm;
    const mark = delta > 150 ? "  <-- pays a handshake" : "";
    console.log(
      `  after ${String(rung.idle).padStart(3)}s idle              ` +
        `${rung.ms.toFixed(0).padStart(5)}ms  (${delta >= 0 ? "+" : ""}${delta.toFixed(0)}ms)${mark}`
    );
  }
  const at90 = r.rungs.find((x) => x.idle === 90);
  const cost = at90 ? at90.ms - r.warm : NaN;
  console.log();
  if (Number.isFinite(cost) && cost > 150) {
    console.log(`  VERDICT: the socket does not survive the scheduler's wait.`);
    console.log(`  An armed mint pays ~${cost.toFixed(0)}ms it does not have to.`);
    console.log(`  Re-run with a fine ladder (3,5,8,12,20) to find the cliff before`);
    console.log(`  picking an interval - measured 2026-08-20 it sits between 3s and`);
    console.log(`  5s on both chains, which is Cloudflare's 5s keep-alive timeout.`);
  } else if (Number.isFinite(cost)) {
    console.log(`  VERDICT: connection survives 90s. No keep-alive ping needed —`);
    console.log(`  the floor is the network, and relocating is the only lever left.`);
  }
  console.log();
}

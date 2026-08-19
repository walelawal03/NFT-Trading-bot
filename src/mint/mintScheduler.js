import { CHAINS } from "../chains.js";
import { detectNftMint } from "./nftMintDetect.js";
import { executeMint, buildMintCall } from "./nftMintExecutor.js";

// Fires a mint the moment its phase opens.
//
// This is the only path where speed is winnable. A human pasting an address
// and tapping CONFIRM is bounded by how fast they can read; a mint armed ten
// minutes early is bounded only by how long the send takes, because
// everything else — the phase parameters, the calldata, the fee recipient —
// was resolved while nothing was happening.
//
// The prepare/fire split is the whole design:
//
//   prepare  (well before open): read the drop, build the exact calldata,
//            resolve the fee recipient. Seconds of RPC, spent when seconds
//            are free.
//   fire     (at open): send. No reads, no building, no decisions.
//
// Doing the reads at fire time is what makes a bot slow, and on Robinhood's
// public RPC those reads measured 2-5 seconds — with one at 23. That is the
// gap this closes.

const armed = new Map(); // key -> armed mint

// How early to prepare. Long enough that a slow RPC round trip cannot eat
// into the window, short enough that the phase parameters are unlikely to
// have been rewritten since.
const PREPARE_LEAD_MS = 90_000;

// How often to check. Cheap: it is a clock comparison against a timestamp
// already in memory, not a network call.
const TICK_MS = 1_000;

const keyFor = (chainKey, contractAddress) => `${chainKey}:${contractAddress.toLowerCase()}`;

/**
 * Arms a mint for when its phase opens.
 *
 * Refuses a phase that has already opened — that is not a scheduled mint,
 * it is a mint, and it should go through CONFIRM where the person can see
 * what they are about to spend.
 */
export function armMint({ chain, contractAddress, detect, quantity, walletCount, priceOverrideWei = null, chatId }) {
  const startsAt = detect.phase?.startsAt ?? null;
  if (!startsAt) return { ok: false, reason: "This drop has no scheduled phase to wait for." };
  if (startsAt.getTime() <= Date.now()) return { ok: false, reason: "That phase is already open — use CONFIRM MINT." };

  const key = keyFor(chain.key, contractAddress);
  armed.set(key, {
    key, chainKey: chain.key, contractAddress, quantity, walletCount, priceOverrideWei, chatId,
    startsAtMs: startsAt.getTime(),
    prepared: null,
    fired: false,
    detect,
  });
  return { ok: true, startsAt, armedCount: armed.size };
}

export function disarmMint(chainKey, contractAddress) {
  return armed.delete(keyFor(chainKey, contractAddress));
}

export function listArmedMints() {
  return [...armed.values()].map((a) => ({
    chainKey: a.chainKey, contractAddress: a.contractAddress,
    quantity: a.quantity, walletCount: a.walletCount,
    startsAt: new Date(a.startsAtMs), prepared: Boolean(a.prepared), fired: a.fired,
  }));
}

/**
 * Re-reads the drop and builds the calldata ahead of the open.
 *
 * Re-reads rather than trusting what was armed: a creator can update the
 * public drop right up to the open, and minting against a stale price is a
 * guaranteed revert. This is the last moment that read is free.
 */
async function prepare(entry, notify) {
  const chain = { key: entry.chainKey, ...CHAINS[entry.chainKey] };
  try {
    const detect = await detectNftMint(chain, entry.contractAddress, { budgetMs: 8000 });
    const call = await buildMintCall(chain, {
      detect, contractAddress: entry.contractAddress,
      quantity: entry.quantity, priceOverrideWei: entry.priceOverrideWei,
    });
    entry.detect = detect;
    entry.prepared = { call, preparedAt: Date.now() };

    // If the phase moved while we waited, follow it rather than firing at a
    // time that no longer means anything.
    if (detect.phase?.startsAt) entry.startsAtMs = detect.phase.startsAt.getTime();
  } catch (err) {
    entry.prepared = null;
    await notify?.(entry.chatId, `⚠️ Couldn't prepare the scheduled mint for \`${entry.contractAddress}\`: ${err.message}`);
  }
}

async function fire(entry, notify) {
  entry.fired = true;
  const chain = { key: entry.chainKey, ...CHAINS[entry.chainKey] };
  try {
    const result = await executeMint(chain, {
      detect: entry.detect,
      contractAddress: entry.contractAddress,
      quantity: entry.quantity,
      priceOverrideWei: entry.priceOverrideWei,
      walletCount: entry.walletCount,
    });
    const sent = result.results.filter((r) => r.ok);
    const failed = result.results.filter((r) => !r.ok);
    const lines = [
      result.ok ? `🚀 *Scheduled mint fired* — ${entry.contractAddress}` : `⛔️ *Scheduled mint did not send* — ${result.reason ?? "all wallets failed"}`,
      ...sent.map((r) => `  ✅ \`${r.address.slice(0, 10)}…\` ${r.txHash}`),
      ...failed.map((r) => `  ⚠️ \`${r.address.slice(0, 10)}…\` ${r.stage}: ${r.reason}`),
    ];
    await notify?.(entry.chatId, lines.join("\n"));
  } catch (err) {
    await notify?.(entry.chatId, `⚠️ Scheduled mint failed: ${err.message}`);
  } finally {
    armed.delete(entry.key);
  }
}

/**
 * Runs the arm/prepare/fire loop.
 *
 * A plain interval rather than cron: cron's finest resolution is a minute,
 * and a mint that opens at :00 and sells out by :15 does not care what the
 * bot planned to do at :01.
 */
export function startMintScheduler({ notify } = {}) {
  const timer = setInterval(async () => {
    const now = Date.now();
    for (const entry of armed.values()) {
      if (entry.fired) continue;
      if (!entry.prepared && now >= entry.startsAtMs - PREPARE_LEAD_MS) await prepare(entry, notify);
      if (now >= entry.startsAtMs) await fire(entry, notify);
    }
  }, TICK_MS);
  timer.unref?.();
  console.log(`[mintScheduler] armed-mint loop running (${TICK_MS}ms tick, prepares ${PREPARE_LEAD_MS / 1000}s ahead)`);
  return () => clearInterval(timer);
}

import fs from "node:fs";
import path from "node:path";
import { CHAINS } from "../chains.js";
import { getDataDir } from "../dataDir.js";
import { detectNftMint } from "./nftMintDetect.js";
import { prepareSignedMints, broadcastSigned } from "./nftMintExecutor.js";
import { getProvider } from "../wallet.js";

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

// How often to poke the RPC connection while an armed mint waits.
//
// This is the single largest saving available anywhere in the fire path, and
// it costs nothing. Measured against both chains from the same machine
// (scripts/socketDecay.js, 2026-08-20), first call after N seconds of silence:
//
//              warm    3s idle   5s idle   20s idle
//   Base       255ms   266ms     586ms     571ms
//   Robinhood  173ms   172ms     496ms     530ms
//
// The cliff is between 3s and 5s on both — Cloudflare fronts every one of
// these endpoints and closes idle connections on a 5s keep-alive timeout. So
// the scheduler, which prepares 90s ahead and then goes quiet, was handing
// every armed mint a DEAD socket: fire paid a full TCP + TLS handshake at the
// exact moment it could least afford one, ~320ms on top of a ~170ms round
// trip. That is where the "573ms at best" figure in nftMintExecutor.js came
// from — it was never the floor, it was a cold fire.
//
// 2s, not 3s: 3s is the last measurement known to be warm, and picking the
// last known-good value leaves no room for a slow tick or a jittery moment.
// Over a 90s wait this is ~45 eth_blockNumber calls, which is nothing.
//
// morsy's bot warms sockets deliberately; CLAUDE.md lists it as one of that
// bot's strengths. It is not a micro-optimisation, it is two thirds of the
// latency gap.
const KEEPALIVE_MS = 2_000;

// Backoff after a failed preparation. Without one, a drop whose price cannot
// be read is re-prepared on every tick for the whole 90-second lead: ninety
// bursts of RPC against the endpoint we need to be responsive at the open,
// caused by us. Doubling from 5s gives a handful of honest retries instead.
const PREPARE_RETRY_BASE_MS = 5_000;
const PREPARE_RETRY_MAX_MS = 30_000;

// Where armed mints survive a restart. This bot runs under pm2 and gets
// restarted for every deploy — without this, arming a mint for tomorrow and
// restarting tonight loses it silently, which is the worst possible failure
// for a feature whose entire promise is "it will fire without you".
//
// Deliberately the opposite decision from mintSession.js, which refuses to
// persist a half-configured mint. The difference is that prepare() re-reads
// the drop from the chain before firing, so a restored entry never mints
// against remembered numbers — only against a remembered INTENTION.
const armedPath = () => path.join(getDataDir(), "armedMints.json");

const keyFor = (chainKey, contractAddress) => `${chainKey}:${contractAddress.toLowerCase()}`;

/**
 * Says what happened, to the console AND to Telegram.
 *
 * Every outcome here used to go only to Telegram. On the first live scheduled
 * mint (Black GUYT, 2026-08-20) that send failed —
 *
 *   [mintScheduler] notify failed: connect ETIMEDOUT 149.154.166.110:443
 *
 * — from Lagos, where reaching Telegram is not guaranteed. The mint itself was
 * perfect: fired on time, first block, first of ten minters. Nobody was told.
 * Worse, because prepare() also reported only to Telegram, the logs could not
 * confirm it had even run; the only way to know the bot had worked was to read
 * the chain by hand.
 *
 * For a feature whose entire promise is "it fires without you", a silent
 * success is nearly as bad as a silent failure. The console is the transport
 * that cannot fail — it is local, pm2 keeps it, and it costs nothing.
 *
 * Markdown is stripped for the console line: asterisks and backticks are for
 * Telegram, and they make a log line harder to read, not easier.
 */
async function report(notify, chatId, message, level = "log") {
  console[level](`[mintScheduler] ${message.replace(/[*`]/g, "").replace(/\n\s*/g, " | ")}`);
  await notify?.(chatId, message);
}

// Throttled per CHAIN rather than per armed mint: three drops armed on the
// same chain share one connection pool, so three pings would buy exactly what
// one buys and spend three times the requests.
const lastWarmedAt = new Map(); // chainKey -> ms

function keepConnectionWarm(chainKey, now) {
  if (now - (lastWarmedAt.get(chainKey) ?? 0) < KEEPALIVE_MS) return;
  lastWarmedAt.set(chainKey, now);
  // Deliberately not awaited and deliberately silent. The tick must never
  // block on it, and a failed ping is not news — the next one is 2s away, and
  // if the endpoint is genuinely down the mint has larger problems that
  // prepare() and fire() both report properly.
  //
  // send() rather than getBlockNumber(): ethers caches the latter, and a
  // cache hit sends no packet, which would keep nothing warm at all. That
  // exact mistake made the first version of socketDecay.js report 0ms.
  getProvider({ key: chainKey, ...CHAINS[chainKey] })
    .send("eth_blockNumber", [])
    .catch(() => {});
}

// Only the intention is written. Signed transactions and the detect snapshot
// stay in memory: a signature carries a nonce that will be stale after a
// restart, and persisting one would invite firing it.
function persist() {
  try {
    const rows = [...armed.values()]
      .filter((a) => !a.fired)
      .map((a) => ({
        chainKey: a.chainKey,
        contractAddress: a.contractAddress,
        quantity: a.quantity,
        walletCount: a.walletCount,
        priceOverrideWei: a.priceOverrideWei == null ? null : a.priceOverrideWei.toString(),
        chatId: a.chatId,
        startsAtMs: a.startsAtMs,
      }));
    fs.writeFileSync(armedPath(), JSON.stringify({ armed: rows }, null, 2));
  } catch (err) {
    console.error("[mintScheduler] could not persist armed mints:", err.message);
  }
}

function readPersisted() {
  try {
    const data = JSON.parse(fs.readFileSync(armedPath(), "utf8"));
    return Array.isArray(data?.armed) ? data.armed : [];
  } catch {
    return [];
  }
}

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
    // Guards against the loop re-entering prepare while one is in flight.
    // prepareSignedMints costs ~2.5s against this RPC and the tick is 1s, so
    // without this the ordinary case starts it three times — three sets of
    // transactions signed against the same nonce, of which at most one can
    // ever land. Measured, not theorised: tests/mintScheduler.test.mjs.
    preparing: false,
    prepareFailures: 0,
    nextPrepareAtMs: 0,
    fireTimer: null,
    fired: false,
    detect,
  });
  persist();
  return { ok: true, startsAt, armedCount: armed.size };
}

export function disarmMint(chainKey, contractAddress) {
  const key = keyFor(chainKey, contractAddress);
  // The exact-fire timer holds its own reference to the entry, so dropping it
  // from the map is not enough — without this, disarming inside the last two
  // seconds still fires.
  const entry = armed.get(key);
  if (entry?.fireTimer) clearTimeout(entry.fireTimer);
  const removed = armed.delete(key);
  if (removed) persist();
  return removed;
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
  entry.preparing = true;
  const chain = { key: entry.chainKey, ...CHAINS[entry.chainKey] };
  try {
    // Re-read: a creator can rewrite the public drop right up to the open,
    // and this was observed live — a drop's advertised price and per-wallet
    // cap both changed within a day. Minting against what was armed would be
    // a guaranteed revert.
    const detect = await detectNftMint(chain, entry.contractAddress, { budgetMs: 8000 });
    entry.detect = detect;
    if (detect.phase?.startsAt) entry.startsAtMs = detect.phase.startsAt.getTime();

    // Sign here, not at fire. Nonce, fee data, gas estimate and signature are
    // all knowable in advance and together cost ~2.5s against this RPC —
    // spent now, while nothing is happening, so firing is one round trip.
    // Simulate and estimate AT THE OPEN, not at now. Preparation runs 90s
    // early by design, and a drop's own `startTime <= block.timestamp` check
    // rejects both the simulation and the gas estimate until it opens — so
    // without this every armed mint failed to prepare and fire() refused for
    // want of anything to send. Confirmed against a live drop (Chica,
    // 2026-08-19): totalSupply reached 25 while our wallet's nonce never
    // moved. A few seconds past the open, because a block timestamp is not
    // guaranteed to land exactly on it.
    const openSec = Math.floor(entry.startsAtMs / 1000) + 5;
    const nowSec = Math.floor(Date.now() / 1000);
    const prep = await prepareSignedMints(chain, {
      detect,
      contractAddress: entry.contractAddress,
      quantity: entry.quantity,
      priceOverrideWei: entry.priceOverrideWei,
      walletCount: entry.walletCount,
      atTimestamp: openSec > nowSec ? openSec : null,
    });

    if (!prep.ok) {
      entry.prepared = null;
      scheduleRetry(entry);
      // Reported once, not once per retry — the notification is for a person,
      // and a phone buzzing every five seconds for ninety seconds is not
      // information.
      if (entry.prepareFailures === 1) {
        await report(notify, entry.chatId, `⚠️ Couldn't prepare \`${entry.contractAddress}\`: ${prep.reason ?? prep.signed.map((x) => x.reason).filter(Boolean).join("; ")} — retrying until it opens.`, "error");
      }
      return;
    }
    // The call is kept alongside the signatures so a stale nonce can be
    // recovered at fire time without redoing any of the reads.
    entry.prepared = { signed: prep.signed, call: prep.call, preparedAt: Date.now() };
    entry.prepareFailures = 0;
    const ready = prep.signed.filter((x) => x.ok).length;
    await report(notify, entry.chatId, `🔧 Prepared ${ready} signed transaction(s) for \`${entry.contractAddress}\` — firing at the open.`);
  } catch (err) {
    entry.prepared = null;
    scheduleRetry(entry);
    if (entry.prepareFailures === 1) {
      await report(notify, entry.chatId, `⚠️ Couldn't prepare the scheduled mint for \`${entry.contractAddress}\`: ${err.message} — retrying until it opens.`, "error");
    }
  } finally {
    entry.preparing = false;
  }
}

function scheduleRetry(entry) {
  entry.prepareFailures += 1;
  const backoff = Math.min(PREPARE_RETRY_BASE_MS * 2 ** (entry.prepareFailures - 1), PREPARE_RETRY_MAX_MS);
  entry.nextPrepareAtMs = Date.now() + backoff;
}

async function fire(entry, notify) {
  entry.fired = true;
  const chain = { key: entry.chainKey, ...CHAINS[entry.chainKey] };
  const t0 = Date.now();
  try {
    // Nothing is prepared if preparation failed. Firing anyway would mean
    // doing every slow step at the worst possible moment, so it reports
    // instead — a missed mint is better than a mint that arrives late AND
    // reverts.
    if (!entry.prepared) {
      await report(notify, entry.chatId, `⛔️ \`${entry.contractAddress}\` opened but nothing was prepared — not firing.`, "error");
      return;
    }

    const results = await broadcastSigned(chain, entry.prepared.signed, { call: entry.prepared.call });
    const elapsed = Date.now() - t0;
    const sent = results.filter((r) => r.ok);
    const failed = results.filter((r) => !r.ok);
    const dry = sent.some((r) => r.stage === "dry-run");

    const lines = [
      !sent.length
        ? `⛔️ *Scheduled mint failed* — ${entry.contractAddress}`
        : dry
          ? `🧪 *Scheduled dry run* — ${sent.length} would have fired in ${elapsed}ms`
          : `🚀 *Scheduled mint fired* in ${elapsed}ms — ${entry.contractAddress}`,
      ...sent.map((r) =>
        r.stage === "dry-run"
          ? `  ✅ \`${r.address.slice(0, 10)}…\` (dry run)`
          : `  ✅ \`${r.address.slice(0, 10)}…\` \`${r.txHash}\` (${r.sendMs}ms)${r.note ? ` — ${r.note}` : ""}`
      ),
      ...failed.map((r) => `  ⚠️ \`${r.address.slice(0, 10)}…\` ${r.stage}: ${r.reason}`),
    ];
    await report(notify, entry.chatId, lines.join("\n"), sent.length ? "log" : "error");
  } catch (err) {
    await report(notify, entry.chatId, `⚠️ Scheduled mint failed: ${err.message}`, "error");
  } finally {
    if (entry.fireTimer) clearTimeout(entry.fireTimer);
    armed.delete(entry.key);
    persist();
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
  restoreArmedMints(notify);

  const timer = setInterval(() => {
    const now = Date.now();
    for (const entry of armed.values()) {
      if (entry.fired) continue;

      // Before anything else, and before the fireTimer branch below returns
      // early — the whole point is that the connection is alive at the moment
      // fire() sends, so the last ping must land within the keep-alive window
      // of the send itself. Runs for the entire preparation lead, so the
      // reads prepare() makes are warm too.
      if (now >= entry.startsAtMs - PREPARE_LEAD_MS) keepConnectionWarm(entry.chainKey, now);

      // Never awaited across entries. Two armed mints are independent, and
      // awaiting one entry's 2.5s preparation before even looking at the next
      // means a mint opening in that window fires late for a reason that has
      // nothing to do with it.
      if (!entry.prepared && !entry.preparing && now >= entry.nextPrepareAtMs && now >= entry.startsAtMs - PREPARE_LEAD_MS) {
        // Fire-and-forget: prepare owns its own guard and error handling, and
        // the tick must not block on it.
        prepare(entry, notify);
      }

      // Inside the last couple of seconds, stop polling and schedule the fire
      // on an exact timer.
      //
      // A 1s tick means up to a full second of the drop is spent waiting for
      // the next loop iteration — measured: the first real armed mint fired
      // 1.3s after the open, of which 724ms was the send and the rest was
      // this. On a drop that fills in seconds that gap is the difference, and
      // it is the one part of the delay that costs nothing to remove.
      if (entry.prepared && !entry.fireTimer && now >= entry.startsAtMs - 2000) {
        entry.fireTimer = setTimeout(() => fire(entry, notify), Math.max(0, entry.startsAtMs - Date.now()));
        continue;
      }

      // fire() sets entry.fired synchronously before its first await, so a
      // later tick arriving mid-broadcast cannot send the same mint twice.
      if (now >= entry.startsAtMs) fire(entry, notify);
    }
  }, TICK_MS);
  timer.unref?.();
  console.log(`[mintScheduler] armed-mint loop running (${TICK_MS}ms tick, prepares ${PREPARE_LEAD_MS / 1000}s ahead)`);
  return () => clearInterval(timer);
}

/**
 * Brings back mints armed before the last restart.
 *
 * A restored mint whose phase opened while the process was down is NOT fired.
 * That mirrors armMint's refusal to arm an already-open phase, and for the
 * same reason: firing into a window that opened at an unknown point in the
 * past is a decision, not a schedule. It is reported so the person can decide,
 * which is the one thing a silent loss never let them do.
 */
function restoreArmedMints(notify) {
  const rows = readPersisted();
  if (!rows.length) return;

  let restored = 0;
  const missed = [];
  for (const row of rows) {
    if (!CHAINS[row.chainKey]) continue;
    // Never overwrite a live entry with a disk copy: the in-memory one may
    // already hold signed transactions, and replacing it would silently throw
    // away a completed preparation.
    if (armed.has(keyFor(row.chainKey, row.contractAddress))) continue;
    if (row.startsAtMs <= Date.now()) {
      missed.push(row);
      continue;
    }
    armed.set(keyFor(row.chainKey, row.contractAddress), {
      key: keyFor(row.chainKey, row.contractAddress),
      chainKey: row.chainKey,
      contractAddress: row.contractAddress,
      quantity: row.quantity,
      walletCount: row.walletCount,
      priceOverrideWei: row.priceOverrideWei == null ? null : BigInt(row.priceOverrideWei),
      chatId: row.chatId,
      startsAtMs: row.startsAtMs,
      // Nothing signed is restored. A signature carries a nonce, and the
      // wallet may well have moved since — prepare() will rebuild it.
      prepared: null,
      preparing: false,
      prepareFailures: 0,
      nextPrepareAtMs: 0,
      fireTimer: null,
      fired: false,
      detect: null,
    });
    restored++;
  }

  persist();
  console.log(`[mintScheduler] restored ${restored} armed mint(s)${missed.length ? `, ${missed.length} opened while down` : ""}`);

  for (const row of missed) {
    // Console too: a mint that opened while the process was down is the single
    // event most worth finding in a log afterwards, and a restart is exactly
    // when the Telegram send is least likely to succeed.
    report(
      notify,
      row.chatId,
      `⏰ \`${row.contractAddress}\` opened at ${new Date(row.startsAtMs).toISOString().replace("T", " ").slice(0, 16)} UTC while the bot was restarting, so it was not fired. Paste the address to mint it now.`,
      "warn"
    ).catch(() => {});
  }
}

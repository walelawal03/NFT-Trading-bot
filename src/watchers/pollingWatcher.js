import { ethers } from "ethers";
import { hasSeenPair, markPairSeen } from "../store/db.js";
import { getLogProvider } from "../wallet.js";

const POLL_INTERVAL_MS = 5000;
const MAX_BLOCK_RANGE = 1000; // per-request cap; also how far a single cycle catches up if behind
// How far back to backfill on startup, instead of jumping straight to
// "latest" and silently losing anything created during downtime. lastBlock
// only ever lives in memory (never persisted), so every process restart —
// and on Railway, every deploy is a restart, plus a chain toggle spins up a
// brand new watcher instance — previously meant a permanent blind window.
// 5000 blocks is generous relative to this chain's recent fast block rate
// (minutes, not hours) without risking a slow chunk-by-chunk catch-up on a
// genuinely fresh deploy; hasSeenPair() dedup makes re-scanning already-seen
// pairs harmless if the real gap was smaller than this.
const STARTUP_BACKFILL_BLOCKS = 5000;

// How many consecutive archive rejections on the same range before giving up
// on it and skipping to the tip. Skipping throws away a detection window, so
// it must stay a last resort — but never skipping means one un-servable range
// stalls detection permanently, which is worse.
//
// This used to fire on the FIRST rejection, from before the RPC layer could
// fail over. That made sense when a rejection was final; now most are
// transient and already recovered by a different endpoint or a retry (9 hours
// of production logs: 8 eth_getLogs rejections, 7 recovered on retry, 1 not),
// so treating the first one as fatal discards a window that would have been
// fine three seconds later.
const ARCHIVE_SKIP_AFTER_FAILURES = 3;

function topic0For(factory) {
  if (factory.topic0) return factory.topic0;
  return new ethers.Interface(factory.abi).getEvent(factory.event).topicHash;
}

function decode(factory, log, iface) {
  if (factory.topic0) return factory.parse(log); // raw mode — parse works off the Log directly
  const parsed = iface.parseLog(log);
  return factory.parse(parsed.args);
}

// Same job as startPairWatcher, but for chains whose WS endpoint doesn't
// speak eth_subscribe (Robinhood Chain's public "feed" is a proprietary
// sequencer stream, not JSON-RPC). Polls eth_getLogs on an interval instead.
//
// Each factory tracks its own lastBlock/timer independently. A high-density
// event source (a launchpad firing every few seconds) and a quiet one
// sharing a chain must not be able to stall each other — a shared cursor
// meant one factory's transient failure froze progress for both, and the
// unprocessed range then grew every cycle until even more requests failed.
export function startPollingWatcher(chain, onNewToken) {
  let stopped = false;
  // The log-specific endpoint list, not the trade-execution one: those two
  // sets are disjoint on BSC, where the dataseed endpoints used for trading
  // reject eth_getLogs outright and only publicnode answers it. Failing over
  // between them is handled inside the provider.
  const provider = getLogProvider(chain);

  function handleLog(factory, iface, log) {
    try {
      const [token0, token1, pairAddress] = decode(factory, log, iface);

      if (hasSeenPair(chain.key, pairAddress)) return;
      const wrapped = chain.wrappedNative.toLowerCase();
      const t0 = token0.toLowerCase();
      const t1 = token1.toLowerCase();
      if (t0 !== wrapped && t1 !== wrapped) return;

      const tokenAddress = t0 === wrapped ? token1 : token0;
      markPairSeen(chain.key, pairAddress, tokenAddress);
      onNewToken({ chain, dexName: factory.dexName, pairAddress, tokenAddress, timestamp: Date.now() });
    } catch (err) {
      console.error(`[${chain.key}/${factory.dexName}] error decoding log:`, err.message);
    }
  }

  const states = chain.factories.map((factory) => ({
    factory,
    topic0: topic0For(factory),
    iface: factory.topic0 ? null : new ethers.Interface(factory.abi),
    lastBlock: null,
    timer: null,
    archiveFailures: 0,
  }));

  async function pollOne(state) {
    if (stopped) return;
    try {
      const currentBlock = await provider.getBlockNumber();
      if (state.lastBlock === null) {
        state.lastBlock = Math.max(0, currentBlock - STARTUP_BACKFILL_BLOCKS);
      }
      if (currentBlock > state.lastBlock) {
        // Bounded catch-up: if we're behind by more than one chunk, only
        // advance one chunk this cycle instead of requesting the whole gap
        // in one (increasingly large, increasingly failure-prone) call.
        const to = Math.min(state.lastBlock + MAX_BLOCK_RANGE, currentBlock);
        const logs = await provider.getLogs({
          address: state.factory.address,
          topics: [state.topic0],
          fromBlock: state.lastBlock + 1,
          toBlock: to,
        });
        for (const log of logs) handleLog(state.factory, state.iface, log);
        state.lastBlock = to;
      }
      state.archiveFailures = 0;
    } catch (err) {
      console.error(`[${chain.key}/${state.factory.dexName}] poll failed:`, err.message);
      // Some free-tier RPCs (confirmed on BSC's public endpoint) reject
      // eth_getLogs for any range older than roughly their last minute of
      // blocks, calling it an "archive request." Without an escape hatch, a
      // doomed historical range (e.g. the startup backfill) retries
      // identically forever every cycle, permanently stalling detection at
      // zero instead of just losing that one backfill window.
      //
      // But skipping is not free — it abandons every block in the gap, and
      // any pair created in it is never seen. So it now takes repeated
      // failures on the same range, and says out loud what it is discarding
      // rather than moving the cursor silently.
      if (/archive|personal token/i.test(err.message)) {
        state.archiveFailures++;
        if (state.archiveFailures >= ARCHIVE_SKIP_AFTER_FAILURES) {
          try {
            const tip = await provider.getBlockNumber();
            // lastBlock is still null if the very first getBlockNumber was
            // what failed — nothing has been scanned yet, so nothing is being
            // abandoned and there is no block count worth quoting.
            const abandoned = state.lastBlock === null ? null : tip - state.lastBlock;
            console.warn(
              `[${chain.key}/${state.factory.dexName}] skipping to block ${tip} after ${state.archiveFailures} archive rejections` +
                (abandoned === null
                  ? " (no range scanned yet)"
                  : ` — abandoning ${abandoned} unscanned block(s); any pair created in them will be missed`)
            );
            state.lastBlock = tip;
            state.archiveFailures = 0;
          } catch {
            // leave lastBlock as-is; next cycle will retry from here
          }
        }
      }
    } finally {
      if (!stopped) state.timer = setTimeout(() => pollOne(state), POLL_INTERVAL_MS);
    }
  }

  for (const state of states) {
    console.log(`[${chain.key}] polling ${state.factory.dexName} (${state.factory.address}) every ${POLL_INTERVAL_MS}ms`);
    pollOne(state);
  }

  return function stop() {
    stopped = true;
    states.forEach((s) => {
      if (s.timer) clearTimeout(s.timer);
    });
  };
}

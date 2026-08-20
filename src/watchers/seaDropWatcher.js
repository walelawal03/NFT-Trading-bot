import { id } from "ethers";
import { getLogProvider } from "../wallet.js";

// Finds drops BEFORE they open, without OpenSea.
//
// The collection watcher next door polls OpenSea's "recently created
// collections". That is the wrong instrument for a mint bot on Base: OpenSea
// indexes a collection some time after it exists, and on Base that is
// routinely after the mint is over. Measured 2026-08-20 across the 24 Base
// collections the OpenSea watcher had found — 22 closed or sold out, 0 open,
// 1 upcoming, and that one opens in December. Nothing armable, ever.
//
// SeaDrop announces the phase itself. A creator configuring a public drop
// calls updatePublicDrop, SeaDrop emits PublicDropUpdated carrying the start
// time, and that happens BEFORE the drop opens — which is precisely the
// window an armed mint needs. It is one eth_getLogs against one address, no
// aggregator anywhere on the path, and it works on a collection nothing has
// indexed yet.
//
// Verified live on both chains before this was written. In a single ~1000
// block window: 12 events on Base, 11 on Robinhood, several priced at zero,
// with start times minutes to a day out.
//
// CAVEAT, and it is why the mint path re-reads rather than trusting this: a
// creator can emit again and change everything. Observed the same hour —
// Evolastion (0x0164196308f7cf2e9a27ccd0ffd89dfcbc0fb91f) announced at price
// 0 and was charging 0.01 ETH by the time it opened. This watcher says "a
// drop exists and when it starts"; it does not say what it will cost. Only
// the read at prepare time does that, and mintScheduler already makes it.

// SeaDrop 1.0, the same canonical address on every chain that has it —
// confirmed deployed with identical 21081-byte code on Base and Robinhood.
// Kept in step with nftMintDetect.js's SEADROP_1_0.
const SEADROP_1_0 = "0x00005EA00Ac477B1030CE78506496e8C2dE24bf5";

// event PublicDropUpdated(address indexed nftContract, PublicDrop publicDrop)
// struct PublicDrop { uint80 mintPrice; uint48 startTime; uint48 endTime;
//                     uint16 maxTotalMintableByWallet; uint16 feeBps;
//                     bool restrictFeeRecipients; }
const PUBLIC_DROP_UPDATED = id("PublicDropUpdated(address,(uint80,uint48,uint48,uint16,uint16,bool))");

// Faster than the OpenSea watcher's 30s because this is the one signal with a
// deadline attached: a drop announced 90 seconds before it opens is still
// armable, and one found 90 seconds after it opens is not. Cheap enough to
// justify — a single eth_getLogs against a single address.
const POLL_INTERVAL_MS = 20_000;

// Both chains' log endpoints serve 1000-block spans (see the measured tables
// in chains.js). Base produces a block every ~2s, so one span is ~33 minutes
// of history and a 20s poll never comes close to falling behind.
const MAX_SPAN_BLOCKS = 1000;

// How far back to look on the first poll, so a restart does not miss a drop
// announced while the process was down. Deliberately modest: a drop announced
// more than a span ago has usually already opened, and re-reporting old ones
// on every boot would train the operator to ignore the alerts.
const STARTUP_LOOKBACK_BLOCKS = 300;

/**
 * Decodes one PublicDropUpdated log.
 *
 * The struct is not packed — each field occupies its own 32-byte word — so
 * this reads words rather than bit-slicing. Getting that wrong would produce
 * plausible-looking nonsense (a price of zero, a start time in 1970) rather
 * than an error, which is exactly the kind of bug that reaches production.
 */
function decodeDrop(log) {
  const words = (log.data.slice(2).match(/.{64}/g) || []).map((w) => BigInt("0x" + w));
  if (words.length < 6) return null;
  const startSec = Number(words[1]);
  const endSec = Number(words[2]);
  if (!startSec) return null;
  return {
    contractAddress: "0x" + log.topics[1].slice(26),
    priceWei: words[0],
    startsAt: new Date(startSec * 1000),
    endsAt: endSec ? new Date(endSec * 1000) : null,
    maxPerWallet: Number(words[3]),
    feeBps: Number(words[4]),
    restrictFeeRecipients: words[5] === 1n,
    blockNumber: log.blockNumber,
  };
}

/**
 * @param onDrop  called with a decoded drop whose phase has NOT yet opened.
 */
export function startSeaDropWatcher(chain, onDrop, { pollMs = POLL_INTERVAL_MS } = {}) {
  let stopped = false;
  let timer = null;
  let cursor = null;
  // Creators re-emit: the same drop configured twice produces two identical
  // events, and a creator adjusting the price produces two different ones for
  // the same contract. Keyed on contract + start so a genuine reschedule is
  // reported again while a duplicate is not.
  const seen = new Set();

  async function poll() {
    if (stopped) return;
    try {
      const provider = getLogProvider(chain);
      const head = await provider.getBlockNumber();
      if (cursor == null) cursor = Math.max(1, head - STARTUP_LOOKBACK_BLOCKS);
      if (head <= cursor) return;

      const to = Math.min(head, cursor + MAX_SPAN_BLOCKS);
      const logs = await provider.getLogs({
        address: SEADROP_1_0,
        topics: [PUBLIC_DROP_UPDATED],
        fromBlock: cursor + 1,
        toBlock: to,
      });
      // Advance only after the query succeeds. Advancing first would silently
      // skip a window whenever the endpoint had a bad minute, and the whole
      // point of this watcher is not missing the announcement.
      cursor = to;

      for (const log of logs) {
        const drop = decodeDrop(log);
        if (!drop) continue;
        // Already open is not a finding. armMint refuses it, and reporting it
        // would bury the ones that are still actionable.
        if (drop.startsAt.getTime() <= Date.now()) continue;
        const key = `${drop.contractAddress}:${drop.startsAt.getTime()}`;
        if (seen.has(key)) continue;
        seen.add(key);
        onDrop({ chain, ...drop });
      }
    } catch (err) {
      console.error(`[${chain.key}] SeaDrop poll failed:`, err.message);
    } finally {
      if (!stopped) timer = setTimeout(poll, pollMs);
    }
  }

  console.log(`[${chain.key}] watching SeaDrop for upcoming drops every ${pollMs}ms (no OpenSea on this path)`);
  poll();

  return function stop() {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}

export const SEADROP_WATCH = { SEADROP_1_0, PUBLIC_DROP_UPDATED, decodeDrop };

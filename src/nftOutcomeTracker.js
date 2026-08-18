import cron from "node-cron";
import { isPaused } from "./botState.js";
import { getCollectionStats } from "./risk/opensea.js";
import { getNftCallsPendingOutcome, recordNftCallOutcome, NFT_OUTCOME_HORIZONS } from "./store/db.js";

const CHECK_CRON = "*/30 * * * *";

// Snapshots each eligible call's floor price at every horizon it has become
// old enough for, recording the % change from call-time floor.
//
// Three horizons, because two different questions are being asked of the
// same rows. 24h is the flip label — did this signal move the floor — and
// it is what getWalletTrackRecord() aggregates per copy-traded wallet. 7d
// and 30d are the rug label: a collection that gets abandoned still has a
// floor the next morning, so 24h cannot see abandonment at all, and that is
// the horizon a deployer's record is built on (getNftDeployerRealizedRecord).
//
// Each horizon has its own checked_at column, so they settle independently
// and a row keeps accumulating history rather than being finished by the
// first snapshot.
//
// Runs independently of whether the bot ever actually bought anything for
// that call (paper/real trading could be off, or budget-exhausted) — this
// measures "was the signal any good," not "did we profit from it."
export function startNftOutcomeTracker() {
  let running = false;

  const task = cron.schedule(CHECK_CRON, async () => {
    if (isPaused() || running) return;
    running = true;
    try {
      for (const horizon of NFT_OUTCOME_HORIZONS) {
        const pending = getNftCallsPendingOutcome(Date.now() - horizon.ms, horizon.key);
        for (const call of pending) {
          try {
            const stats = await getCollectionStats(call.collection_slug);
            const outcomeFloorEth = stats?.floorPriceEth ?? null;
            const outcomePct =
              outcomeFloorEth != null && call.call_floor_price_eth > 0
                ? ((outcomeFloorEth - call.call_floor_price_eth) / call.call_floor_price_eth) * 100
                : null;
            recordNftCallOutcome(call.id, { outcomeFloorEth, outcomePct }, horizon.key);
          } catch (err) {
            // Leave this horizon's checked_at unset — retried next cycle. A
            // transient OpenSea failure shouldn't permanently lose this
            // call's outcome data, and it must not block the other horizons.
            console.error(
              `[nftOutcomeTracker] ${horizon.key} check failed for ${call.name || call.contract_address}:`,
              err.message
            );
          }
        }
      }
    } finally {
      running = false;
    }
  });

  console.log(`[nftOutcomeTracker] scheduled every 30m, horizons: ${NFT_OUTCOME_HORIZONS.map((h) => h.key).join(", ")}`);
  return task;
}

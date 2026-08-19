import { CHAINS } from "./chains.js";
import { getActiveChainDefs, setChainEnabled, loadEnabledChains } from "./chainSettings.js";
import { isPaused } from "./botState.js";
import { countPending, countSeen, countCalled, countCalledNft } from "./store/db.js";
import { createBot } from "./telegram/bot.js";
import { startMilestoneChecker, startWatchlistDigest } from "./priceUpdater.js";
import { startRecheckQueue } from "./recheckQueue.js";
import { startTrackUpdater } from "./trackUpdater.js";
import { startStalePriceRugCheck } from "./stalePriceRugCheck.js";
import { startPaperTradeChecker } from "./paperTrading.js";
import { startRealTradeChecker } from "./realTrading.js";
import { config } from "./config.js";
import { startNftCollectionWatcher } from "./watchers/nftCollectionWatcher.js";
import { startNftWalletWatcher } from "./watchers/nftWalletWatcher.js";
import { evaluateNftCollection } from "./nftPipeline.js";
import { startNftBuyRecheckQueue } from "./nftBuyRecheckQueue.js";
import { startNftPaperTradeChecker } from "./nftPaperTrading.js";
import { startNftRealTradeChecker } from "./nftRealTrading.js";
import { startNftOutcomeTracker } from "./nftOutcomeTracker.js";
import { startMintScheduler } from "./mint/mintScheduler.js";
import { getNftChainDefs } from "./nftChains.js";

// Last line of defense: an async failure anywhere that isn't already
// caught (a cron job's send call, a stray promise) otherwise crashes the
// whole process by default in modern Node. Log it and keep running instead
// — a single failed message send should never take the bot down.
process.on("unhandledRejection", (err) => {
  console.error("Unhandled rejection (bot kept running):", err?.message || err);
});
process.on("uncaughtException", (err) => {
  console.error("Uncaught exception (bot kept running):", err?.message || err);
});

// seen/called are always read fresh from the DB (not in-memory counters) so
// they reflect true cumulative totals across restarts, not just this run.
const stats = {
  get seen() { return countSeen(); },
  get called() { return countCalled(); },
  get pending() { return countPending(); },
  get nftCalled() { return countCalledNft(); },
};

async function handleNewNftCollection({ chain, contractAddress }) {
  if (isPaused()) return;
  console.log(`[${chain.key}] new NFT collection ${contractAddress}`);
  try {
    const result = await evaluateNftCollection(bot, { chain, contractAddress, source: "new_collection" });
    if (result.pass) {
      console.log(`[${chain.key}] called NFT ${result.name || "?"} (${contractAddress}) — score ${result.riskResult.score}`);
    }
  } catch (err) {
    console.error(`[${chain.key}] failed to process NFT collection ${contractAddress}:`, err.message);
  }
}

async function handleWalletNftBuy({ chain, walletAddress, contractAddress, priceEth }) {
  if (isPaused()) return;
  console.log(`[${chain.key}] watched wallet ${walletAddress} bought NFT ${contractAddress} for ${priceEth ?? "?"} ETH`);
  try {
    const result = await evaluateNftCollection(bot, {
      chain,
      contractAddress,
      source: "copy_trade",
      triggerWallet: { address: walletAddress, buyPriceEth: priceEth },
    });
    if (result.pass) {
      console.log(`[${chain.key}] called NFT ${result.name || "?"} (${contractAddress}) via copy signal — score ${result.riskResult.score}`);
    }
  } catch (err) {
    console.error(`[${chain.key}] failed to process copy-trade NFT ${contractAddress}:`, err.message);
  }
}

// Chains can be toggled live from the bot's Chains menu, so watchers start
// and stop dynamically instead of being fixed at boot.
const activeWatchers = new Map(); // chainKey -> stop function

// THIS BOT DOES NOT WATCH TOKENS.
//
// It was seeded from the token bot's repo and the token pipeline came along
// with it. Nothing starts a token watcher at boot, but the path was still
// live: the ⛓ Chains menu is off the main keyboard, yet its callback data
// survives in any older message, and one tap would have started pair
// watching, run evaluateToken, and written token calls into this bot's
// database — including pipeline.js's recordDeployerOutcome, the circular
// scorer feedback that the NFT side was deliberately moved off.
//
// Refused here rather than by deleting the token modules: they are imported
// by shared infrastructure (explorer.js, db.js) that the NFT side genuinely
// uses, so removing them is a much larger change than the leak warrants. The
// chain toggle still persists its setting, so nothing in the UI breaks — it
// simply cannot bring a token watcher up.
function startChainWatcher(chainKey) {
  console.log(`[index] refusing to start a token watcher for ${chainKey} — this is the NFT mint bot`);
}

function stopChainWatcher(chainKey) {
  const stop = activeWatchers.get(chainKey);
  if (!stop) return;
  stop();
  activeWatchers.delete(chainKey);
}

const chainControls = {
  toggleChain(chainKey, enabled) {
    setChainEnabled(chainKey, enabled);
    if (enabled) startChainWatcher(chainKey);
    else stopChainWatcher(chainKey);
  },
  getEnabledKeys: () => loadEnabledChains(),
};

// digestControls is needed by both createBot (for the Watchlist menu) and
// startWatchlistDigest (which needs `bot` to exist first) — break the cycle
// with a stable object that gets patched with the real functions below.
const digestControls = { sendNow: async () => {}, reschedule: () => {} };

const bot = createBot(stats, chainControls, digestControls);

// Armed mints fire on their own clock, independent of the collection
// watchers — scheduling is the one path where speed is winnable, so it must
// not sit behind anything that polls an aggregator.
startMintScheduler({
  notify: async (chatId, message) => {
    await bot.telegram.sendMessage(chatId, message, { parse_mode: "Markdown" }).catch((e) =>
      console.error("[mintScheduler] notify failed:", e.message)
    );
  },
});

// This is the NFT mint underwriter. It is a SEPARATE BOT from the token
// trading bot, and nothing token-related starts here.
//
// The repo was seeded from the token bot's tree, so those modules are still
// present on disk — but the pair watchers and the token pipeline are no
// longer imported here at all, and the recheck queue, milestone/track
// updaters, paper- and real-trade checkers and stale-price rug check are
// deliberately not started. Left running, this process would evaluate token
// launches and post token calls into the NFT bot's Telegram chat, which is
// not what this bot is for.
//
// The remaining token modules stay on disk rather than being deleted because
// bot.js still renders the shared menus that reference them, and because
// explorer.js and db.js are genuinely shared with the NFT side. Pruning that
// is a separate job from making sure none of it RUNS. If a token watcher ever
// needs to come back, it belongs in the other bot, not here.

// NFT support lives entirely behind OPENSEA_API_KEY being configured —
// with no key, none of this starts and the rest of the bot behaves exactly
// as it did before this feature existed. Which chains it watches (default
// Base + Robinhood Chain, not Ethereum) comes from nftChains.js — one
// collection watcher + one wallet watcher per chain; the pending-listing/
// paper/real-trade checkers already key off each stored row's own `chain`
// field via CHAINS[...], so they don't need per-chain wiring here.
const nftWatcherStops = [];
if (config.openseaApiKey) {
  for (const nftChain of getNftChainDefs()) {
    nftWatcherStops.push(startNftCollectionWatcher(nftChain, handleNewNftCollection));
    nftWatcherStops.push(startNftWalletWatcher(nftChain, handleWalletNftBuy));
  }
  startNftBuyRecheckQueue(bot);
  startNftPaperTradeChecker(bot);
  startNftRealTradeChecker(bot);
  startNftOutcomeTracker();
} else {
  console.log("[nft] OPENSEA_API_KEY not set — NFT features disabled");
}

// bot.launch() only resolves after bot.stop() is called (it awaits the
// polling loop itself), so confirm startup via the onLaunch callback instead.
bot.launch({}, () => console.log(`Telegram bot launched as @${bot.botInfo?.username}.`)).catch((err) => {
  console.error("Telegram bot crashed:", err.message);
  process.exit(1);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    console.log(`Received ${signal}, shutting down…`);
    activeWatchers.forEach((stop) => stop());
    nftWatcherStops.forEach((stop) => stop());
    bot.stop(signal);
    process.exit(0);
  });
}

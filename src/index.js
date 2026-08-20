import { isPaused } from "./botState.js";
import { countCalledNft } from "./store/db.js";
import { createBot } from "./telegram/bot.js";
import { config } from "./config.js";
import { startNftCollectionWatcher } from "./watchers/nftCollectionWatcher.js";
import { startNftWalletWatcher } from "./watchers/nftWalletWatcher.js";
import { startSeaDropWatcher } from "./watchers/seaDropWatcher.js";
import { formatEther } from "ethers";
import { evaluateNftCollection } from "./nftPipeline.js";
import { startNftBuyRecheckQueue } from "./nftBuyRecheckQueue.js";
import { startNftPaperTradeChecker } from "./nftPaperTrading.js";
import { startNftRealTradeChecker } from "./nftRealTrading.js";
import { startNftOutcomeTracker } from "./nftOutcomeTracker.js";
import { startMintScheduler } from "./mint/mintScheduler.js";
import { getNftChainDefs } from "./nftChains.js";

// This is the NFT mint underwriter. It is a SEPARATE BOT from the token
// trading bot, and nothing token-related runs — or exists — here any more.
//
// The repo was seeded from the token bot's tree, so for a while this file
// carried pair watchers, a token pipeline, recheck/milestone/track updaters
// and paper/real trade checkers. They were first stopped, then deleted
// outright along with the modules behind them: leaving them on disk meant a
// stale callback in an old Telegram message could still reach them, and one
// tap would have written token calls into this bot's database. If a token
// watcher is ever wanted again it belongs in the other bot, not here.

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

// Read fresh from the DB (not an in-memory counter) so it reflects the true
// cumulative total across restarts, not just this run.
const stats = {
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

// A drop announced but not yet open — the only kind that can be armed.
//
// Reported rather than acted on. What the announcement carries is a schedule,
// not a price: a creator can re-emit with different terms right up to the
// open, observed the same hour this was written (Evolastion announced free,
// opened at 0.01 ETH). Deciding to spend belongs to the person, after a fresh
// read of the contract — which is what pasting the address does.
async function handleUpcomingDrop({ chain, contractAddress, priceWei, startsAt, maxPerWallet }) {
  if (isPaused()) return;
  const price = priceWei === 0n ? "FREE" : `${formatEther(priceWei)} ${chain.nativeSymbol || "ETH"}`;
  const mins = Math.round((startsAt.getTime() - Date.now()) / 60000);
  console.log(
    `[${chain.key}] upcoming drop ${contractAddress} — ${price}, opens ${startsAt.toISOString()} (in ${mins}m), max ${maxPerWallet}/wallet`
  );
  // Free drops only. A paid one is a spending decision that deserves the mint
  // card rather than a push notification, and alerting on every configured
  // drop on Base would be a message every few minutes.
  if (priceWei !== 0n) return;
  const text =
    `🆓 *Free drop opening in ${mins}m* — ${chain.label}\n` +
    `\`${contractAddress}\`\n` +
    `Opens ${startsAt.toISOString().replace("T", " ").slice(0, 19)}Z · max ${maxPerWallet}/wallet\n\n` +
    `_Terms can still change before it opens — paste the address to read it fresh and arm it._`;
  await bot.telegram
    .sendMessage(config.telegram.chatId, text, { parse_mode: "Markdown" })
    .catch((e) => console.error("[seaDrop] notify failed:", e.message));
}

const bot = createBot(stats);

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

// Collection discovery and wallet copy-trading live entirely behind
// OPENSEA_API_KEY being configured — with no key, none of this starts and the
// bot is still fully usable for its main job, since pasting a drop and minting
// it never touches OpenSea. Which chains it watches (default Base + Robinhood
// Chain, not Ethereum) comes from nftChains.js — one collection watcher + one
// wallet watcher per chain; the pending-listing/paper/real-trade checkers
// already key off each stored row's own `chain` field via CHAINS[...], so they
// don't need per-chain wiring here.
// Drop discovery reads SeaDrop's own event log, so it runs whether or not an
// OpenSea key exists — deliberately outside the block below. It is the one
// discovery path that works on a collection nothing has indexed, which on
// Base is most of them while the mint is still open.
const nftWatcherStops = getNftChainDefs().map((nftChain) =>
  startSeaDropWatcher(nftChain, handleUpcomingDrop)
);

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
  console.log("[nft] OPENSEA_API_KEY not set — collection discovery and copy-trading disabled");
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
    nftWatcherStops.forEach((stop) => stop());
    bot.stop(signal);
    process.exit(0);
  });
}

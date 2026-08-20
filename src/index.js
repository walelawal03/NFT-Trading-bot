import { isPaused, isNftNotificationsEnabled } from "./botState.js";
import { countCalledNft } from "./store/db.js";
import { createBot } from "./telegram/bot.js";
import { config } from "./config.js";
import { startNftCollectionWatcher } from "./watchers/nftCollectionWatcher.js";
import { startNftWalletWatcher } from "./watchers/nftWalletWatcher.js";
import { startSeaDropWatcher } from "./watchers/seaDropWatcher.js";
import { detectNftMint } from "./mint/nftMintDetect.js";
import { detectNftDangerousFunctions, assessNftContractRisk } from "./risk/nftDangerousFunctions.js";
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

// How soon a drop must open to be worth a notification.
//
// The first version alerted on every free drop the moment it was announced,
// and on Robinhood that is a message every couple of minutes — including one
// opening in November, 99 days out. A push notification is a claim on
// attention right now, and a drop three months away is not that. Both bounds
// exist because being too early is as useless as being too late:
//
//   under the floor, there is no time to arm it — the scheduler needs 90s to
//   re-read, sign and prepare, and a drop opening in 60 seconds can only be
//   minted by hand
//   over the ceiling, it is a diary entry, not an alert
const ALERT_MIN_LEAD_MS = 3 * 60 * 1000;
const ALERT_MAX_LEAD_MS = 12 * 60 * 60 * 1000;

// Which chains are worth a push notification, as opposed to a log line.
//
// Base only, and this is the whole reason the SeaDrop watcher was built: on
// Base, OpenSea indexes a collection after the mint is usually over, drops are
// short, and the field is deep — so learning about one early is the only way
// to enter it at all.
//
// Robinhood is the opposite on every count. Its drops stay open for around a
// day, so nothing is lost by finding one later through the OpenSea watcher;
// the field is four to ten transactions deep, so there is no race to lose;
// and a large share of what gets announced is people testing — "xyztest",
// "Test mint j", "Apheonn3" sold out at 10/10 before its public phase. The
// first hour of alerts was almost entirely Robinhood, almost entirely noise.
//
// Still WATCHED on every chain, because the log is a complete record and the
// post-mortem reads from it. This governs interruption only. One line to
// change if Robinhood ever gets busy enough to be worth racing.
const ALERT_CHAINS = new Set(["base"]);

// A drop announced but not yet open — the only kind that can be armed.
//
// Underwritten before it is announced, which is the entire point of this bot:
// discovery alone is a firehose, and CLAUDE.md's premise is that we compete on
// SELECTION, not on being the first to know a drop exists. Every alert
// therefore carries a name, a supply, and the Stage A bytecode verdict, and a
// contract that fails the hard gate is never announced at all.
//
// Still reports rather than acts. What the announcement carries is a schedule,
// not a price: a creator can re-emit with different terms right up to the
// open, observed the same hour this was written (Evolastion announced free,
// opened at 0.01 ETH). Deciding to spend belongs to the person, after a fresh
// read — which is what pasting the address does, and what prepare() redoes.
async function handleUpcomingDrop({ chain, contractAddress, priceWei, startsAt, maxPerWallet }) {
  if (isPaused()) return;
  const price = priceWei === 0n ? "FREE" : `${formatEther(priceWei)} ${chain.nativeSymbol || "ETH"}`;
  const leadMs = startsAt.getTime() - Date.now();
  const mins = Math.round(leadMs / 60000);
  console.log(
    `[${chain.key}] upcoming drop ${contractAddress} — ${price}, opens ${startsAt.toISOString()} (in ${mins}m), max ${maxPerWallet}/wallet`
  );

  // Everything below this line decides whether to INTERRUPT someone. The log
  // line above is the complete record either way.
  // The mute the operator already set.
  //
  // This path originally called bot.telegram.sendMessage directly and so
  // ignored it — which meant a bot with NFT notifications explicitly turned
  // OFF started sending a new kind of NFT notification. Every other NFT
  // message respects this flag (postNftUpdate and postNftCall both check it);
  // a new one that does not is not a new feature, it is a broken switch.
  //
  // Toggle lives in the 🖼 NFTs menu, and the underlying discovery keeps
  // running and logging regardless — this governs the interruption only.
  if (!isNftNotificationsEnabled()) return;
  if (!ALERT_CHAINS.has(chain.key)) return;
  if (priceWei !== 0n) return;
  if (leadMs < ALERT_MIN_LEAD_MS || leadMs > ALERT_MAX_LEAD_MS) return;

  try {
    // Both reads are pure RPC — no OpenSea, no explorer — so they work on a
    // contract deployed a minute ago, which is every drop this watcher finds.
    const [detect, scan] = await Promise.all([
      detectNftMint(chain, contractAddress, { budgetMs: 8000 }).catch(() => null),
      detectNftDangerousFunctions(chain, contractAddress, { budgetMs: 8000 }).catch(() => null),
    ]);
    const verdict = scan ? assessNftContractRisk(scan) : null;

    // A contract that can seize or freeze what you mint is not a lead. It is
    // silently dropped rather than announced with a warning, because an alert
    // that has to be read carefully is an alert that will eventually be
    // skimmed.
    if (verdict?.fatal) {
      console.log(`[${chain.key}] not alerting ${contractAddress} — FATAL: ${verdict.flags?.join(", ")}`);
      return;
    }

    // Sold out before it opens. Not a contradiction: the supply can be minted
    // through an allowlist or by the creator ahead of the public phase, and
    // the public phase is still dutifully announced. Observed on the first
    // batch of real alerts — Apheonn3 was 10/10 with a public drop scheduled
    // two hours out. There is nothing to mint, so there is nothing to say.
    if (detect?.soldOut) {
      console.log(`[${chain.key}] not alerting ${contractAddress} — already sold out (${detect.totalSupply}/${detect.maxSupply})`);
      return;
    }

    const name = detect?.name ? `*${detect.name}*` : "Unnamed collection";
    const supply =
      detect?.maxSupply != null ? `${detect.totalSupply ?? 0}/${detect.maxSupply} minted` : "supply unknown";
    // Proportionate, because a warning on the ordinary case is not a warning.
    // Almost every drop scores −10 for "metadata destination unknown" plus a
    // setMaxSupply setter, and both are what a normal pre-reveal collection
    // looks like. Leading those with ⚠️ trains the reader to skim past the
    // symbol, which is precisely when a real finding gets missed.
    //
    // Flags are long sentences ("Metadata destination unknown: Could not read
    // a token URI (likely pre-reveal or non-standard)"), so only the part
    // before the colon is shown — the clause after it is the explanation, and
    // the alert is not the place to explain.
    const shortFlags = (verdict?.flags || []).map((f) => String(f).split(":")[0]).slice(0, 2).join(", ");
    const gate = !verdict
      ? "⚠️ contract unreadable — treat as unknown"
      : verdict.unknown
        ? `⚠️ partially unreadable (−${verdict.deduction})`
        : verdict.deduction === 0
          ? "✅ clean bytecode"
          : verdict.deduction <= 10
            ? `✅ nothing dangerous · −${verdict.deduction} ${shortFlags}`
            : `⚠️ −${verdict.deduction}: ${shortFlags}`;

    const text =
      `🆓 *Free drop in ${mins}m* — ${chain.label}\n` +
      `${name} · ${supply} · max ${maxPerWallet}/wallet\n` +
      `${gate}\n` +
      `\`${contractAddress}\`\n\n` +
      `_Paste the address to read it fresh and arm it — terms can still change before it opens._`;
    await bot.telegram
      .sendMessage(config.telegram.chatId, text, { parse_mode: "Markdown" })
      .catch((e) => console.error("[seaDrop] notify failed:", e.message));
  } catch (err) {
    console.error(`[${chain.key}] could not underwrite upcoming drop ${contractAddress}:`, err.message);
  }
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

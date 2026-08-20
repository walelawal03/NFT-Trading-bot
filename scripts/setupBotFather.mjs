// BotFather setup, done through the Bot API rather than by hand.
// Everything here is reversible and idempotent — safe to re-run.
import "dotenv/config";
import { Telegraf } from "telegraf";

const tg = new Telegraf(process.env.TELEGRAM_BOT_TOKEN).telegram;

// This list must stay in step with the bot.command() handlers in
// telegram/bot.js — a command advertised here that no longer exists is worse
// than one that was never advertised, because Telegram autocompletes it and
// the tap does nothing. The token commands this list used to exclude by hand
// no longer exist at all.
const commands = [
  { command: "start", description: "Show the main menu" },
  { command: "mint", description: "Read a drop's mint config: price, phase, max per wallet, and how it mints" },
  { command: "mintwallets", description: "Import and manage the wallets a mint is spread across" },
  { command: "mintsettings", description: "Minting on/off, dry run, and the spend ceiling" },
  { command: "armed", description: "List mints armed to fire when their phase opens" },
  { command: "disarm", description: "Cancel an armed mint" },
  { command: "holdings", description: "The NFTs these wallets actually hold, verified on-chain" },
  { command: "nftcheck", description: "Scan a contract — no OpenSea, no GoPlus. Works on brand-new contracts" },
  { command: "nftscore", description: "Full risk score for a collection (needs OpenSea to have indexed it)" },
  { command: "nftfilter", description: "Show the current NFT filter thresholds" },
  { command: "setnftfilter", description: "Change one NFT filter threshold" },
  { command: "watchwallet", description: "Watch a wallet for NFT copy-trade signals" },
  { command: "unwatchwallet", description: "Stop watching a wallet" },
  { command: "watchwallets", description: "List watched wallets and their track records" },
  { command: "status", description: "Bot status and counters" },
  { command: "chatid", description: "Show this chat's ID" },
];

const shortDescription =
  "NFT mint underwriter. Reads the contract itself — capability scan, exit risk, owner track record — before you mint.";

const description = [
  "NFT mint underwriter for Base and Robinhood Chain.",
  "",
  "Scores a collection on what its bytecode can actually do: seizure and transfer-lock capabilities, upgradeable logic, mutable metadata, supply and royalty controls. Runs off plain RPC, so it answers for a contract deployed sixty seconds ago that no aggregator has indexed yet.",
  "",
  "/nftcheck <address> — static contract scan, no external APIs.",
].join("\n");

const results = [];
const step = async (label, fn) => {
  try { await fn(); results.push(`  ok   ${label}`); }
  catch (e) { results.push(`  FAIL ${label} — ${e.message}`); }
};

await step("setMyCommands (default scope)", () => tg.setMyCommands(commands));
await step("setMyShortDescription", () => tg.callApi("setMyShortDescription", { short_description: shortDescription }));
await step("setMyDescription", () => tg.callApi("setMyDescription", { description }));
await step("setChatMenuButton (commands menu)", () => tg.callApi("setChatMenuButton", { menu_button: { type: "commands" } }));

console.log(results.join("\n"));

console.log("\n=== readback ===");
const got = await tg.getMyCommands();
console.log("commands registered:", got.length);
for (const c of got) console.log(`  /${c.command} — ${c.description}`);
const sd = await tg.callApi("getMyShortDescription", {});
const d = await tg.callApi("getMyDescription", {});
const me = await tg.getMe();
console.log(`\n@${me.username} (${me.first_name})`);
console.log("short:", sd.short_description);
console.log("about:", d.description.split("\n")[0], "…");

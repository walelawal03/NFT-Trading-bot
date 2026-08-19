// Swaps the mint roster onto a fresh, dedicated burner.
//
// Why this exists: the first wallet imported here was the token trading
// bot's own wallet (same address as degenbot's WALLET_PRIVATE_KEY), which
// sends transactions of its own. A pre-signed mint carries its nonce in the
// signature, so a wallet that does anything else invalidates mints armed
// against it — and both bots draw down the same balance.
//
// The generated key is written to data/mintWallets.json and printed NOWHERE.
// You fund the address; the bot holds the key. Treat it as a hot wallet: put
// in what a mint costs, not a treasury.
//
//   node scripts/newMintWallet.mjs            # add a burner
//   node scripts/newMintWallet.mjs --replace 0xOLD   # add one and drop the old
import "dotenv/config";
import { Wallet } from "ethers";
import { formatEther } from "ethers";
import { CHAINS } from "../src/chains.js";
import { getProvider } from "../src/wallet.js";
import { importMintWallets, removeMintWallet, listMintWallets } from "../src/mint/mintWallets.js";

const replaceIdx = process.argv.indexOf("--replace");
const toRemove = replaceIdx > -1 ? process.argv[replaceIdx + 1] : null;

const burner = Wallet.createRandom();
const results = importMintWallets(burner.privateKey);
if (!results[0]?.ok) {
  console.error("Could not add the burner:", results[0]?.reason);
  process.exit(1);
}

if (toRemove) {
  const gone = removeMintWallet(toRemove);
  console.log(gone ? `removed ${toRemove}` : `nothing in the roster matched ${toRemove}`);
}

console.log(`\nNew mint wallet: ${burner.address}`);
console.log("  key stored in data/mintWallets.json (gitignored) — not shown here, not in any chat");
console.log("  BACK THAT FILE UP: lose it and you lose whatever is in this wallet\n");

console.log("Fund it on the chain you mint on, then check:");
for (const key of ["robinhood", "base"]) {
  const bal = await getProvider({ key, ...CHAINS[key] }).getBalance(burner.address).catch(() => null);
  console.log(`  ${key.padEnd(10)} ${bal == null ? "?" : formatEther(bal)} ETH`);
}

console.log("\nRoster now:");
for (const w of listMintWallets()) console.log(`  ${w.address}`);

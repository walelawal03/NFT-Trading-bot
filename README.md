# NFT Mint Underwriter

Telegram bot that decides whether a drop is worth minting, then mints it.

It is not a sniper. Operating from Lagos on public RPC means 150–250ms RTT
against competitors colocated near the sequencer, and that gap is physics, not
code. So it doesn't compete on speed. It competes on **selection** (not minting
rugs), **exits** (most mint bots have none), and **chain timing** (young chains
where bot infrastructure hasn't arrived yet).

Default chains are Base, Ethereum mainnet, Arbitrum, Monad, Arc, and Robinhood Chain.
The app reads `NFT_CHAINS`; `CHAINS` is accepted as a legacy alias in `.env`.

## What it does today

1. **Reads the drop from a pasted address or link.** `nftMintDetect.js` resolves
   the mint entrypoint — SeaDrop or a direct `mint`/`publicMint` on the
   collection — along with price, phase window, max per wallet, and remaining
   supply. Straight from chain state, so it works on a contract deployed sixty
   seconds ago that no aggregator has indexed.
2. **Stage A — the bytecode gate.** `nftDangerousFunctions.js` extracts the
   contract's selectors and matches them against 82 known-dangerous ones across
   six tables: seizure and transfer locks are fatal, metadata/supply/economics/
   upgrade controls deduct, a freeze capability earns points back. Resolves
   EIP-1167, EIP-1967, EIP-1822 and beacon proxies before reading, so a proxied
   drop isn't scored as an empty shell.
3. **Stage B — the exit simulation.** `nftRoundTripProbe.js` mints one and
   moves it in a single atomic `eth_call`, with probe bytecode and a scratch
   balance planted by state override. Zero gas, no key, nothing broadcast. The
   operator half borrows Seaport's own address, so a transfer validator's
   allowlist is consulted for the address a real sale would actually use.
   Answers whether the token can be sold — soulbound, approval-blocked and
   operator-blocked are separate verdicts, not one.
4. **Mints it,** across as many burner wallets as you've imported, with a spend
   ceiling, a dry-run default, gas estimation and nonce-conflict recovery. A
   phase that hasn't opened yet can be armed: the scheduler prepares and signs
   90 seconds ahead against a block-timestamp override, then fires on an exact
   timer.
5. **Tracks what you hold and can list it.** Holdings are verified by `ownerOf`
   rather than trusted from a local file, and listing signs with the burner that
   actually holds the token.

Collection discovery and wallet copy-trading run behind `OPENSEA_API_KEY`.
Everything above works without it.

## Setup

1. **Create the bot**: message [@BotFather](https://t.me/BotFather), run
   `/newbot`, copy the token into `TELEGRAM_BOT_TOKEN`.
2. **Get your chat id**: [@userinfobot](https://t.me/userinfobot) for your
   personal id, or a channel/group's numeric id (starts with `-100`). Put it in
   `TELEGRAM_CHAT_ID`.
3. **Get your user id** for admin-gated actions — same bot — into
   `ADMIN_USER_ID`.
4. Copy `.env.example` to `.env`. The default RPC endpoints need no signup.
5. Set `REAL_TRADING_PASSCODE`. Without it the wallet menu locks itself out
   rather than exposing key reveal and key replacement behind a single tap.
6. Optional: `ETHERSCAN_API_KEY` (deployer lookups; falls back to Blockscout or the chain's explorer API),
   `OPENSEA_API_KEY` (discovery, copy-trading, floor prices, listing).

```bash
npm install
npm start
```

Then publish the command list once:

```bash
node scripts/setupBotFather.mjs
```

## Telegram commands

- `/start` — main menu
- `/mint <address>` — read a drop's mint config
- `/mintwallets` — import and manage the burner wallets a mint spreads across
- `/mintsettings` — minting on/off, dry run, spend ceiling
- `/armed`, `/disarm` — mints waiting on a phase to open
- `/holdings` (`/nfts`) — what those wallets actually hold, verified on-chain
- `/nftcheck <address>` — contract scan, no OpenSea, no GoPlus
- `/nftscore <address>` — full risk score (needs OpenSea to have indexed it)
- `/nftfilter`, `/setnftfilter <key> <value>` — filter thresholds
- `/watchwallet`, `/unwatchwallet`, `/watchwallets` — copy-trade signals
- `/status`, `/chatid`

Pasting a bare address or an OpenSea link needs no command at all — it opens
the mint card directly.

## Command line

```bash
node scripts/nftScan.js <chain> <address...>   # read-only, no wallet
node scripts/newMintWallet.mjs                 # generate a burner
```

## Tests

Offline. The provider is stubbed via `mock.module`, so there is no network, no
env, and no test-only exports in production code.

```bash
TELEGRAM_BOT_TOKEN=x TELEGRAM_CHAT_ID=1 ADMIN_USER_ID=1 \
  node --experimental-test-module-mocks tests/<suite>.test.mjs
```

## Notes

- Chains live in `src/chains.js`; which of them the NFT side watches is
  `src/nftChains.js`. Robinhood Chain's WSS is a sequencer feed, not a JSON-RPC
  endpoint, which is why it carries two HTTP endpoints and no derived one.
- Storage is SQLite at `data/bot.sqlite`.
- This repo was seeded from a token trading bot. That bot is a separate
  project; none of it remains here.
- Not financial advice. A passing scan means no known-dangerous capability was
  found and the exit simulated cleanly — it is not a prediction that anyone
  will want to buy the thing.

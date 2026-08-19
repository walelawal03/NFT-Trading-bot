import { CHAINS } from "../chains.js";
import { getNftChainKeys } from "../nftChains.js";
import { detectNftMint } from "../mint/nftMintDetect.js";
import { buildMintDetectMessage } from "./formatMintDetect.js";
import { buildMintConfigText, mintConfigKeyboard, mintCardExtra, secondaryKeyboard } from "./mintKeyboard.js";
import * as mintSession from "../mint/mintSession.js";

// Paste a contract address or a mint link; get mint options. No command.
//
// This is the bot's primary entry point, not a convenience on top of one.
// Typing /mint before an address is friction at exactly the moment there is
// none to spare, and every extra step is one taken while a drop is filling.

const ADDRESS_IN_TEXT = /0x[a-fA-F0-9]{40}/;

// opensea.io/collection/<slug> — the link you get from OpenSea's own share
// button, and the one people actually paste. It carries no address, so the
// slug has to be resolved. This is the one path that needs OpenSea, and it
// is a fallback: any paste containing an address skips it entirely.
const OPENSEA_SLUG = /opensea\.io\/collection\/([a-zA-Z0-9_-]+)/;

// Chain hints as they appear in the URLs people actually paste — OpenSea
// asset/collection paths, Blockscout, and explorer links all name the chain
// somewhere in the path.
const CHAIN_HINTS = [
  [/robinhood/i, "robinhood"],
  [/\bbase\b/i, "base"],
];

/**
 * Pulls a contract address and, if the text gives one away, a chain out of
 * whatever was pasted: a bare address, an explorer link, an OpenSea asset
 * URL. Returns null when there is no address to act on.
 */
export function parsePastedTarget(text) {
  const nftChains = getNftChainKeys();
  const hinted = CHAIN_HINTS.find(([re, key]) => re.test(text) && nftChains.includes(key));

  const match = String(text).match(ADDRESS_IN_TEXT);
  if (match) return { address: match[0], chainKey: hinted ? hinted[1] : null, slug: null };

  const slug = String(text).match(OPENSEA_SLUG);
  if (slug) return { address: null, chainKey: hinted ? hinted[1] : null, slug: slug[1] };

  return null;
}

// Resolves an OpenSea collection slug to its contract. Kept off the address
// path deliberately: a link that already contains an address never waits on
// OpenSea, because the whole reason this bot reads chains directly is that
// aggregators are slow and often have not indexed a new drop at all.
/**
 * Balance of the first mint wallet, plus the ETH price — both for display.
 *
 * Concurrent and individually fault-tolerant: neither is worth delaying a
 * mint card for, and a missing one renders as absent rather than blocking or
 * throwing. Nothing downstream reads them to decide anything.
 */
export async function loadCardExtras(chain, { slug = null, contractAddress = null } = {}) {
  const { getProvider } = await import("../wallet.js");
  const { listMintWallets } = await import("../mint/mintWallets.js");
  const { getEthUsd } = await import("../mint/nativePrice.js");
  const { getCollectionStats, getBestListingBySlug } = await import("../risk/opensea.js");

  const first = listMintWallets()[0] ?? null;

  // Market data is only meaningful once a collection has traded, and it comes
  // from OpenSea — so it is fetched alongside everything else and every piece
  // fails to null independently. A drop minutes old has none of this, which
  // is normal and must never hold up or break the card.
  const [walletBalanceWei, ethUsd, stats, listing] = await Promise.all([
    first ? getProvider(chain).getBalance(first.address).catch(() => null) : Promise.resolve(null),
    getEthUsd().catch(() => null),
    slug ? getCollectionStats(slug).catch(() => null) : Promise.resolve(null),
    slug ? getBestListingBySlug(slug).catch(() => null) : Promise.resolve(null),
  ]);
  return { walletBalanceWei, ethUsd, stats, listing };
}

// Contract -> OpenSea slug, for the preview card only. Short-circuits to null
// on any failure: an unindexed drop is the normal case here, not an error.
async function resolveSlugForContract(chainKey, contractAddress) {
  try {
    const { getContract } = await import("../risk/opensea.js");
    const info = await getContract(chainKey, contractAddress);
    return info?.slug ?? null;
  } catch {
    return null;
  }
}

async function resolveSlug(slug) {
  const { getCollection } = await import("../risk/opensea.js");
  const collection = await getCollection(slug).catch(() => null);
  if (!collection?.contractAddress) return null;
  const chainKey = getNftChainKeys().find((k) => k === collection.chain) ?? null;
  return { address: collection.contractAddress, chainKey };
}

/**
 * Works out which chain the contract is actually on when the paste didn't say.
 *
 * Straight eth_getCode against each NFT chain — no indexer, no aggregator, so
 * it answers for a contract deployed seconds ago. Runs the chains
 * concurrently because they are independent and the whole point is to not
 * wait.
 */
async function resolveChain(address, hintedKey) {
  const { getProvider } = await import("../wallet.js");
  const keys = hintedKey ? [hintedKey] : getNftChainKeys();

  const found = await Promise.all(
    keys.map(async (key) => {
      const chain = { key, ...CHAINS[key] };
      const code = await getProvider(chain).getCode(address).catch(() => "0x");
      return code && code !== "0x" ? key : null;
    })
  );
  return found.filter(Boolean);
}

/**
 * The whole paste-to-options flow.
 *
 * Answers with the mint config keyboard whenever there is a mint entrypoint,
 * and with the plain report when there isn't — a collection that cannot be
 * minted still deserves an answer rather than silence.
 */
export async function handlePastedTarget(ctx, text) {
  let target = parsePastedTarget(text);
  if (!target) return false;

  if (!target.address && target.slug) {
    const resolved = await resolveSlug(target.slug);
    if (!resolved) {
      await ctx.reply(`Couldn't resolve \`${target.slug}\` on OpenSea. Paste the contract address instead — that path needs no aggregator.`, { parse_mode: "Markdown" });
      return true;
    }
    target = { ...target, ...resolved, chainKey: target.chainKey ?? resolved.chainKey };
  }

  const chainKeys = await resolveChain(target.address, target.chainKey);
  if (chainKeys.length === 0) {
    await ctx.reply(
      `No contract at \`${target.address}\` on ${getNftChainKeys().join(" or ")}.`,
      { parse_mode: "Markdown" }
    );
    return true;
  }

  for (const chainKey of chainKeys) {
    const chain = { key: chainKey, ...CHAINS[chainKey] };
    try {
      // Retry once before giving up. Robinhood's RPC is intermittently slow
      // enough to blow the budget on a contract that reads fine seconds
      // later — measured 1.2s typical against one 7.5s outlier on the same
      // five contracts. "Unreadable" should mean the chain would not answer,
      // not that it was briefly busy. The second attempt gets a longer budget
      // because a person waiting on a paste would rather wait than be told
      // nothing.
      let detect = await detectNftMint(chain, target.address, { budgetMs: 8000 });
      if (!detect.checked) {
        detect = await detectNftMint(chain, target.address, { budgetMs: 20000 });
      }

      // One message when there is something to mint: the drop's details sit
      // directly above the controls that act on them, so nothing has to be
      // scrolled back to before tapping. Only fall back to the standalone
      // report when there are no controls to show.
      if (detect.mintVia) {
        // Slug is only for the link preview — the OpenSea collection page
        // renders a proper card (image, floor, item count) where the bare
        // asset path does not. Deliberately best-effort and last: it is the
        // one OpenSea call in this flow, and a fresh drop OpenSea has not
        // indexed must still get its card without waiting on a miss.
        const openseaSlug = target.slug ?? (await resolveSlugForContract(chain.key, target.address));
        const extras = await loadCardExtras(chain, { slug: openseaSlug, contractAddress: target.address });
        const config = mintSession.startSession(ctx.chat.id, {
          chain,
          contractAddress: target.address,
          detect,
          openseaSlug,
          ...extras,
        });
        await ctx.reply(buildMintConfigText(config), { ...mintCardExtra(config), ...mintConfigKeyboard(config) });
      } else {
        // Sold out or no entrypoint still gets the OpenSea card — you often
        // want to look at a drop you just missed, and the preview is the most
        // useful part of the message when there are no controls to offer.
        // The mint is over. That is exactly when the secondary market becomes
        // the answer, so this path loads floor/volume/listing and offers a
        // buy rather than just reporting that you are too late.
        const openseaSlug = target.slug ?? (await resolveSlugForContract(chain.key, target.address));
        const extras = await loadCardExtras(chain, { slug: openseaSlug, contractAddress: target.address });
        const config = mintSession.startSession(ctx.chat.id, {
          chain,
          contractAddress: target.address,
          detect,
          openseaSlug,
          ...extras,
        });
        await ctx.reply(buildMintConfigText(config), {
          ...mintCardExtra(config),
          ...secondaryKeyboard(config),
        });
      }
    } catch (err) {
      await ctx.reply(`Couldn't read that contract on ${chain.label}: ${err.message}`);
    }
  }
  return true;
}

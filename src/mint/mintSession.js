import { countMintWallets } from "./mintWallets.js";

// The in-progress mint configuration for one chat: which collection, how many
// per wallet, across how many wallets, at what price.
//
// Held in memory, deliberately. A half-configured mint is not worth
// persisting across a restart — the phase may have opened, closed or sold out
// while the process was down, and resuming a stale config is how you send a
// transaction against numbers that stopped being true. A restart drops you
// back to /mint, which re-reads the chain.
const sessions = new Map(); // chatId -> config

// Wallet roster lives in mint/mintWallets.js. Imported here by ADDRESS COUNT
// only — this module never touches a private key, so nothing in the
// configuration path can spend.
export { countMintWallets as walletCount } from "./mintWallets.js";

// Clamp helper that treats "unknown" as "no ceiling we can prove". A contract
// that does not publish a per-wallet cap is not the same as one that caps at
// zero, and defaulting unknown to 0 would make every such drop unmintable.
const clamp = (n, min, max) => Math.max(min, max == null ? n : Math.min(n, max));

export function startSession(chatId, { chain, contractAddress, detect, openseaSlug = null }) {
  const maxPerWallet = detect.phase?.maxPerWallet ?? null;
  const walletCount = countMintWallets();

  const config = {
    chain,
    contractAddress,
    detect,
    // Presentation only — which URL Telegram should render a preview card
    // for. Never used to decide anything about the mint.
    openseaSlug,
    // Start at the cap rather than 1: someone who opened this wants the
    // allocation, and the cap is the answer they would tap toward anyway.
    quantity: maxPerWallet ?? 1,
    wallets: walletCount > 0 ? 1 : 0,
    // null means "use the price the contract reports". An override is only
    // ever an override; it never becomes the source of truth.
    priceOverrideWei: null,
    startedAt: Date.now(),
  };
  sessions.set(chatId, config);
  return config;
}

export function getSession(chatId) {
  return sessions.get(chatId) ?? null;
}

export function clearSession(chatId) {
  sessions.delete(chatId);
}

export function adjustQuantity(chatId, delta) {
  const c = sessions.get(chatId);
  if (!c) return null;
  c.quantity = clamp(c.quantity + delta, 1, c.detect.phase?.maxPerWallet ?? null);
  return c;
}

export function setQuantityMax(chatId) {
  const c = sessions.get(chatId);
  if (!c) return null;
  c.quantity = c.detect.phase?.maxPerWallet ?? c.quantity;
  return c;
}

export function adjustWallets(chatId, delta) {
  const c = sessions.get(chatId);
  if (!c) return null;
  c.wallets = clamp(c.wallets + delta, 0, countMintWallets());
  return c;
}

export function adjustPriceOverride(chatId, deltaWei) {
  const c = sessions.get(chatId);
  if (!c) return null;
  const base = c.priceOverrideWei ?? c.detect.phase?.priceWei ?? 0n;
  const next = base + deltaWei;
  // Never below zero, and clearing back to the contract price is expressed as
  // null rather than as a number that happens to match — so the UI can say
  // "contract price" instead of implying someone chose it.
  c.priceOverrideWei = next < 0n ? 0n : next;
  return c;
}

export function clearPriceOverride(chatId) {
  const c = sessions.get(chatId);
  if (!c) return null;
  c.priceOverrideWei = null;
  return c;
}

// What the whole configuration would cost, at the price actually in force.
// Returns null when the price is unknown — an unknown unit price cannot
// produce a known total, and showing 0 there would read as "free".
export function totalCostWei(config) {
  const unit = config.priceOverrideWei ?? config.detect.phase?.priceWei ?? null;
  if (unit == null) return null;
  return unit * BigInt(config.quantity) * BigInt(Math.max(config.wallets, 1));
}

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

function normalizeWalletAddresses(addresses) {
  if (!Array.isArray(addresses)) return null;
  const seen = new Set();
  const out = [];
  for (const address of addresses) {
    const lower = String(address || "").trim().toLowerCase();
    if (!lower || seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out.length ? out : null;
}

export function selectedWalletAddresses(config) {
  return normalizeWalletAddresses(config?.walletAddresses);
}

export function effectiveWalletCount(config) {
  const selected = selectedWalletAddresses(config);
  if (selected) return selected.length;
  return Math.max(config?.wallets ?? 0, 1);
}

export function startSession(
  chatId,
  {
    chain,
    contractAddress,
    detect,
    openseaSlug = null,
    walletBalanceWei = null,
    ethUsd = null,
    stats = null,
    listing = null,
    roundTrip = null,
    walletEligibility = null,
    quantity = null,
    wallets = null,
    walletAddresses = null,
    priceOverrideWei = null,
  }
) {
  const maxPerWallet = detect.phase?.maxPerWallet ?? null;
  const walletCount = countMintWallets();
  const normalizedWalletAddresses = normalizeWalletAddresses(walletAddresses);

  const config = {
    chain,
    contractAddress,
    detect,
    // Presentation only — which URL Telegram should render a preview card
    // for. Never used to decide anything about the mint.
    openseaSlug,
    // Also presentation only: the first wallet's balance and the ETH price,
    // so the card can say what a mint costs in money you recognise. Neither
    // is consulted when building or sending a transaction — the executor
    // re-reads balance itself, and a price feed must never gate a mint.
    walletBalanceWei,
    ethUsd,
    // Secondary-market view: OpenSea's collection stats and the cheapest
    // live listing. Display, plus the price the buy button fills at.
    stats,
    listing,
    // Result of the mint-then-exit simulation (risk/nftRoundTripProbe.js).
    // Display and warning only — it deliberately does NOT block the mint
    // button. A probe that could not run must never be able to stop a mint,
    // and an exit that is blocked today is still someone's call to make with
    // their own money. It is shown loudly and left as a decision.
    roundTrip,
    walletEligibility,
    // Start at the cap rather than 1: someone who opened this wants the
    // allocation, and the cap is the answer they would tap toward anyway.
    quantity: quantity ?? maxPerWallet ?? 1,
    wallets: wallets ?? (normalizedWalletAddresses?.length ?? (walletCount > 0 ? 1 : 0)),
    walletAddresses: normalizedWalletAddresses,
    // null means "use the price the contract reports". An override is only
    // ever an override; it never becomes the source of truth.
    priceOverrideWei,
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
  c.walletAddresses = null;
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
  return unit * BigInt(config.quantity) * BigInt(effectiveWalletCount(config));
}

// Direct setters for typed entry. Clamping happens at the call site, which
// knows the ceiling; these only guard the floor so a session can never hold
// a quantity that means nothing.
export function setQuantity(chatId, n) {
  const c = sessions.get(chatId);
  if (!c) return null;
  c.quantity = Math.max(1, Math.floor(n));
  return c;
}

export function setWalletCount(chatId, n) {
  const c = sessions.get(chatId);
  if (!c) return null;
  c.walletAddresses = null;
  c.wallets = Math.max(0, Math.min(Math.floor(n), countMintWallets()));
  return c;
}

export function setWalletAddresses(chatId, addresses) {
  const c = sessions.get(chatId);
  if (!c) return null;
  const normalized = normalizeWalletAddresses(addresses);
  c.walletAddresses = normalized;
  c.wallets = normalized ? normalized.length : c.wallets;
  return c;
}

export function clearWalletAddresses(chatId) {
  const c = sessions.get(chatId);
  if (!c) return null;
  c.walletAddresses = null;
  return c;
}

// The most recent confirmed mint for this chat, so the listing controls know
// which token ids they may sell. Deliberately not the wallet's whole balance:
// listing unrelated holdings because they share a contract is not something a
// mint confirmation should be able to do.
const lastResults = new Map();
export function setLastResult(chatId, result) { lastResults.set(chatId, result); }
export function getLastResult(chatId) { return lastResults.get(chatId) ?? null; }

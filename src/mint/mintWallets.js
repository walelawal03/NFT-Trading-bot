import fs from "node:fs";
import path from "node:path";
import { Wallet } from "ethers";
import { getDataDir } from "../dataDir.js";

// The roster of wallets a mint can be spread across.
//
// TRUST BOUNDARY, stated plainly because it is the whole risk of this file:
// keys are stored in plaintext on disk, the same boundary as
// walletSettings.json and the WALLET_PRIVATE_KEY env var this project already
// uses. Anyone who can read the data directory can spend these wallets. That
// is acceptable only because these are meant to be MINTING wallets — funded
// with what a mint costs, not a treasury. Do not put a main wallet here.
//
// Keys are imported, never generated. A bot that mints its own keys is a bot
// that decides how much of your money lives somewhere you did not choose.
const walletsPath = () => path.join(getDataDir(), "mintWallets.json");

function readRaw() {
  try {
    const data = JSON.parse(fs.readFileSync(walletsPath(), "utf8"));
    return Array.isArray(data?.wallets) ? data.wallets : [];
  } catch {
    return [];
  }
}

function writeRaw(wallets) {
  fs.writeFileSync(walletsPath(), JSON.stringify({ wallets }, null, 2));
}

/**
 * Public view of the roster: addresses and labels only.
 *
 * Everything outside the executor uses this. The configuration UI needs to
 * know how many wallets exist and what they are called; it has no business
 * holding the material that can spend them, and keeping the key out of that
 * path means a formatting bug cannot leak one into a chat message.
 */
export function listMintWallets() {
  return readRaw().map((w, i) => ({ index: i, address: w.address, label: w.label ?? null }));
}

export function countMintWallets() {
  return readRaw().length;
}

/**
 * Private keys, for the executor alone. Separate function, deliberately
 * awkward name, so a call site that wants "the wallets" does not get keys by
 * accident.
 */
export function loadMintWalletSigningKeys() {
  return readRaw().map((w) => w.privateKey);
}

/**
 * Imports one or more private keys, one per line.
 *
 * Returns a per-line result rather than throwing on the first bad line: a
 * paste of five keys where the third has a stray character should import four
 * and say which one failed, not reject the batch and invite a re-paste of
 * everything.
 *
 * Never echoes a key back, valid or not — the reason for a rejection is the
 * line number, never its contents.
 */
export function importMintWallets(text) {
  const existing = readRaw();
  const known = new Set(existing.map((w) => w.address.toLowerCase()));
  const results = [];

  const lines = String(text).split(/[\s,]+/).map((l) => l.trim()).filter(Boolean);
  for (const [i, line] of lines.entries()) {
    let wallet;
    try {
      wallet = new Wallet(line.startsWith("0x") ? line : `0x${line}`);
    } catch {
      results.push({ line: i + 1, ok: false, reason: "not a valid private key" });
      continue;
    }
    if (known.has(wallet.address.toLowerCase())) {
      results.push({ line: i + 1, ok: false, address: wallet.address, reason: "already imported" });
      continue;
    }
    known.add(wallet.address.toLowerCase());
    existing.push({ address: wallet.address, privateKey: wallet.privateKey, label: null, importedAt: Date.now() });
    results.push({ line: i + 1, ok: true, address: wallet.address });
  }

  if (results.some((r) => r.ok)) writeRaw(existing);
  return results;
}

export function removeMintWallet(address) {
  const existing = readRaw();
  const next = existing.filter((w) => w.address.toLowerCase() !== String(address).toLowerCase());
  if (next.length === existing.length) return false;
  writeRaw(next);
  return true;
}

export function clearMintWallets() {
  writeRaw([]);
  return true;
}

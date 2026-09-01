import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import { getDataDir } from "../dataDir.js";
import { seedFileIfMissing } from "../dataDir.js";

const dbPath = path.join(getDataDir(), "bot.sqlite");

export const db = new DatabaseSync(dbPath);
db.exec("PRAGMA journal_mode = WAL");

function seedWatchedWallets() {
  seedFileIfMissing("watchedWallets.json");
  const seedPath = path.join(getDataDir(), "watchedWallets.json");
  if (!fs.existsSync(seedPath)) return;

  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(seedPath, "utf8"));
  } catch (err) {
    console.error(`Failed to read watched wallet seed file: ${err.message}`);
    return;
  }

  const wallets = Array.isArray(raw) ? raw : Array.isArray(raw?.wallets) ? raw.wallets : [];
  if (!wallets.length) return;

  const insert = db.prepare("INSERT OR IGNORE INTO watched_wallets (address, label, added_at) VALUES (?, ?, ?)");
  const now = Date.now();
  for (const entry of wallets) {
    const address = typeof entry === "string" ? entry : entry?.address;
    if (!address) continue;
    const label = typeof entry === "string" ? null : entry?.label ?? null;
    insert.run(String(address).toLowerCase(), label || null, typeof entry?.addedAt === "number" ? entry.addedAt : now);
  }
}

db.exec(`
  -- A contract's creator is IMMUTABLE, so a lookup that succeeded once never
  -- needs to be paid for again. That matters because unauthenticated
  -- Blockscout allows roughly 10 requests per 26-minute window per host, and
  -- the collection watcher can hand over 100+ contracts from a single poll
  -- cycle — without this, re-evaluating a collection we already know about
  -- spends quota that was already spent, and starves the ones we don't know.
  --
  -- Only successes are stored. A rate-limited or failed lookup is not a fact
  -- about the contract, it is a fact about the minute we asked in, and caching
  -- it would turn a transient 429 into a permanent "unknown deployer".
  CREATE TABLE IF NOT EXISTS contract_creators (
    chain TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    creator_address TEXT NOT NULL,
    creation_tx TEXT,
    found_at INTEGER NOT NULL,
    PRIMARY KEY (chain, contract_address)
  );

  CREATE TABLE IF NOT EXISTS bot_users (
    telegram_user_id TEXT PRIMARY KEY,
    first_seen_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL
  );

  -- --- NFT tables. Keyed by contract_address, plus token_id where the row
  -- is a specific item rather than a whole collection, since NFTs aren't
  -- fungible the way ERC20s are. ---

  CREATE TABLE IF NOT EXISTS seen_nft_collections (
    chain TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    first_seen_at INTEGER NOT NULL,
    PRIMARY KEY (chain, contract_address)
  );

  CREATE TABLE IF NOT EXISTS called_nft_collections (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    collection_slug TEXT,
    name TEXT,
    image_url TEXT,
    call_floor_price_eth REAL,
    call_volume24h_eth REAL,
    call_num_owners INTEGER,
    call_total_supply INTEGER,
    risk_score INTEGER,
    risk_grade TEXT,
    source TEXT NOT NULL,
    trigger_wallet_address TEXT,
    telegram_message_id INTEGER,
    called_at INTEGER NOT NULL,
    UNIQUE(chain, contract_address)
  );

  -- Dedup for the wallet copy-trade watcher — a wallet's own sale event
  -- (tx_hash) is the natural unique key; wallet_address/contract_address are
  -- kept alongside it purely for querying, not uniqueness.
  CREATE TABLE IF NOT EXISTS nft_copy_signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    wallet_address TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    token_id TEXT,
    tx_hash TEXT NOT NULL,
    detected_at INTEGER NOT NULL,
    UNIQUE(tx_hash, wallet_address, contract_address)
  );

  CREATE TABLE IF NOT EXISTS watched_wallets (
    address TEXT PRIMARY KEY,
    label TEXT,
    added_at INTEGER NOT NULL
  );

  -- "Called but no fulfillable secondary-market listing existed yet" queue —
  -- retried by a recheck loop until a listing appears or the attempt window
  -- expires.
  CREATE TABLE IF NOT EXISTS nft_pending_listings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    called_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    attempts INTEGER NOT NULL DEFAULT 0,
    UNIQUE(chain, contract_address)
  );

  CREATE TABLE IF NOT EXISTS nft_paper_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    token_id TEXT NOT NULL,
    collection_slug TEXT,
    name TEXT,
    entry_price_eth REAL NOT NULL,
    target_multiple REAL NOT NULL,
    stop_floor_pct REAL NOT NULL,
    entry_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    listed_price_eth REAL,
    listed_at INTEGER,
    exit_price_eth REAL,
    exit_at INTEGER,
    exit_reason TEXT,
    pnl_eth REAL,
    pnl_pct REAL,
    status TEXT NOT NULL DEFAULT 'open',
    UNIQUE(chain, contract_address, token_id)
  );

  CREATE TABLE IF NOT EXISTS nft_real_trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chain TEXT NOT NULL,
    contract_address TEXT NOT NULL,
    token_id TEXT NOT NULL,
    collection_slug TEXT,
    name TEXT,
    entry_price_eth REAL NOT NULL,
    target_multiple REAL NOT NULL,
    stop_floor_pct REAL NOT NULL,
    entry_at INTEGER NOT NULL,
    last_checked_at INTEGER,
    listed_price_eth REAL,
    listed_at INTEGER,
    listing_order_hash TEXT,
    exit_price_eth REAL,
    exit_at INTEGER,
    exit_reason TEXT,
    pnl_eth REAL,
    pnl_pct REAL,
    status TEXT NOT NULL DEFAULT 'open',
    entry_tx_hash TEXT,
    entry_gas_eth REAL,
    exit_tx_hash TEXT,
    exit_gas_eth REAL,
    UNIQUE(chain, contract_address, token_id)
  );
`);

// Lightweight migration: add columns to an existing table without needing a
// real migration framework.
function addColumnIfMissing(table, column, definition) {
  const existing = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
  if (!existing.includes(column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}
seedWatchedWallets();
// Post-call outcome snapshot — how did this collection's floor price move
// in the 24h after the call, checked by nftOutcomeTracker.js. Powers the
// per-wallet copy-trade track record (getWalletTrackRecord below): a
// wallet's signals are only as good as what happened afterward, and this
// is the ground truth that gets aggregated per trigger_wallet_address.
// outcome_pct is left null (not computed) when call_floor_price_eth was
// 0/unknown at call time (typical for a new_collection call with no market
// yet) — a percent change from zero is undefined, not just small.
addColumnIfMissing("called_nft_collections", "outcome_checked_at", "INTEGER");
addColumnIfMissing("called_nft_collections", "outcome_floor_eth", "REAL");
addColumnIfMissing("called_nft_collections", "outcome_pct", "REAL");
// Longer horizons, added because 24h answers a different question than the
// one a deployer's record asks. 24h is the right window for a flip label —
// did this signal move the floor — and it stays exactly as it was, feeding
// the copy-trade wallet track record. It is far too short for a rug label:
// a collection that is going to be abandoned still has a floor the next
// morning. 7d and 30d are where that shows up.
addColumnIfMissing("called_nft_collections", "outcome_7d_checked_at", "INTEGER");
addColumnIfMissing("called_nft_collections", "outcome_7d_floor_eth", "REAL");
addColumnIfMissing("called_nft_collections", "outcome_7d_pct", "REAL");
addColumnIfMissing("called_nft_collections", "outcome_30d_checked_at", "INTEGER");
addColumnIfMissing("called_nft_collections", "outcome_30d_floor_eth", "REAL");
addColumnIfMissing("called_nft_collections", "outcome_30d_pct", "REAL");

// Who deployed the collection, captured at call time so a deployer's record
// can later be joined to what actually happened to their drops. Without this
// column the only per-deployer signal available was deployer_history's
// low_score_count, which is written from our own risk score — see
// getNftControllerRealizedRecord below for why that had to stop.
addColumnIfMissing("called_nft_collections", "deployer_address", "TEXT");
// Which KIND of key deployer_address holds: "owner" (from the contract's own
// owner()/getOwner()/admin()) or "deployer" (from an explorer). Both are
// addresses that can move a collection's fate, but they are different facts —
// ownership transfers, deployment doesn't — so pooling them into one
// reputation record would silently merge two populations. Every read filters
// on it. Rows written before this column existed have NULL and match nothing,
// which is correct: we no longer know which kind they were.
addColumnIfMissing("called_nft_collections", "controller_kind", "TEXT");

// Tracks distinct Telegram users who've interacted with the bot, for the
// "Bot Stats" live user count — recorded on every incoming update, not just
// /start, so it stays accurate for users who never explicitly restarted.
export function recordBotUser(telegramUserId) {
  const now = Date.now();
  db.prepare(
    `INSERT INTO bot_users (telegram_user_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?)
     ON CONFLICT(telegram_user_id) DO UPDATE SET last_seen_at = ?`
  ).run(String(telegramUserId), now, now, now);
}

export function countBotUsers() {
  return db.prepare("SELECT COUNT(*) AS n FROM bot_users").get().n;
}

// --- NFT: collection dedup, calls, watched wallets, copy-signal dedup,
// pending-listing recheck queue, paper/real trades. Same conventions as the
// token functions above — see the table comments in the schema block.

export function hasSeenNftCollection(chain, contractAddress) {
  return !!db.prepare("SELECT 1 FROM seen_nft_collections WHERE chain = ? AND contract_address = ?").get(chain, contractAddress);
}

export function markNftCollectionSeen(chain, contractAddress) {
  db.prepare("INSERT OR IGNORE INTO seen_nft_collections (chain, contract_address, first_seen_at) VALUES (?, ?, ?)").run(
    chain,
    contractAddress,
    Date.now()
  );
}

export function hasBeenCalledNft(chain, contractAddress) {
  return !!db.prepare("SELECT 1 FROM called_nft_collections WHERE chain = ? AND contract_address = ?").get(chain, contractAddress);
}

export function recordNftCall(entry) {
  const stmt = db.prepare(`
    INSERT INTO called_nft_collections
      (chain, contract_address, collection_slug, name, image_url, call_floor_price_eth,
       call_volume24h_eth, call_num_owners, call_total_supply, risk_score, risk_grade,
       source, trigger_wallet_address, telegram_message_id, called_at, deployer_address, controller_kind)
    VALUES (@chain, @contractAddress, @collectionSlug, @name, @imageUrl, @callFloorPriceEth,
       @callVolume24hEth, @callNumOwners, @callTotalSupply, @riskScore, @riskGrade,
       @source, @triggerWalletAddress, @telegramMessageId, @calledAt, @deployerAddress, @controllerKind)
    ON CONFLICT(chain, contract_address) DO NOTHING
  `);
  return stmt.run(entry);
}

export function countCalledNft() {
  return db.prepare("SELECT COUNT(*) AS n FROM called_nft_collections").get().n;
}

// --- Copy-trade wallet track record — see the outcome_* column comment
// above for the mechanism. "Pending" means old enough to check (called
// before the cutoff) and not yet checked; only rows with a real call-time
// floor price are eligible (outcome_pct can't be computed from zero).
// The horizons a call is snapshotted at. Column names live here rather than
// in the tracker because they are a storage detail, and because they get
// interpolated into SQL below — keeping the only source of them a frozen
// internal table is what makes that safe. Never build one from input.
export const NFT_OUTCOME_HORIZONS = Object.freeze([
  { key: "24h", ms: 24 * 60 * 60 * 1000, checkedAt: "outcome_checked_at", floor: "outcome_floor_eth", pct: "outcome_pct" },
  { key: "7d", ms: 7 * 24 * 60 * 60 * 1000, checkedAt: "outcome_7d_checked_at", floor: "outcome_7d_floor_eth", pct: "outcome_7d_pct" },
  { key: "30d", ms: 30 * 24 * 60 * 60 * 1000, checkedAt: "outcome_30d_checked_at", floor: "outcome_30d_floor_eth", pct: "outcome_30d_pct" },
]);

function horizonOrThrow(key) {
  const h = NFT_OUTCOME_HORIZONS.find((x) => x.key === key);
  if (!h) throw new Error(`Unknown NFT outcome horizon: ${key}`);
  return h;
}

export function getNftCallsPendingOutcome(calledBefore, horizonKey = "24h") {
  const h = horizonOrThrow(horizonKey);
  return db
    .prepare(
      `SELECT * FROM called_nft_collections
       WHERE ${h.checkedAt} IS NULL AND called_at <= ? AND call_floor_price_eth > 0 AND collection_slug IS NOT NULL`
    )
    .all(calledBefore);
}

export function recordNftCallOutcome(id, { outcomeFloorEth, outcomePct }, horizonKey = "24h") {
  const h = horizonOrThrow(horizonKey);
  db.prepare(
    `UPDATE called_nft_collections SET ${h.checkedAt} = ?, ${h.floor} = ?, ${h.pct} = ? WHERE id = ?`
  ).run(Date.now(), outcomeFloorEth, outcomePct, id);
}

// What actually happened to this controller's previous collections.
//
// This exists to replace a feedback loop, not to add a feature. The old
// per-deployer signal was deployer_history.low_score_count, incremented by
// nftPipeline.js with `{ lowScore: riskResult.score < 40 }` — our own
// scorer's verdict — and read straight back by nftRisk.js to adjust the
// next score. A deployer's reputation was therefore defined by what we had
// previously said about them, never by whether anything rugged. That kind
// of loop converges on something confident and unfalsifiable: it cannot be
// contradicted by reality because reality is not an input.
//
// Realized floor movement is an input reality controls. Only rows with a
// resolved outcome count, so a deployer with no settled history returns
// { collections: 0 } and the caller must treat that as unknown — never as
// clean. Same convention as honeypot: null and checked: false elsewhere.
//
// Expect this to be empty for a long time. There are currently zero NFT
// rows with outcomes, and mint-time calls (source "new_collection") have no
// call-time floor, so they never become eligible at all — see
// getNftCallsPendingOutcome. Honest emptiness is the point; the loop it
// replaces was never empty and never right.
// Uses the longest horizon that has settled for each row — 30d if it is
// there, else 7d — and deliberately does NOT fall back to 24h. A rug label
// drawn at 24h is mostly measuring launch-day volatility, which is the
// reason the longer horizons exist at all; letting it stand in would put
// the fast, noisy number back in charge of the slow question.
export function getNftControllerRealizedRecord(controllerAddress, { kind, ruggedBelowPct = -60 } = {}) {
  const settled = "COALESCE(outcome_30d_pct, outcome_7d_pct)";
  const row = db
    .prepare(
      `SELECT COUNT(*) n,
              AVG(${settled}) avgPct,
              MIN(${settled}) worstPct,
              SUM(CASE WHEN ${settled} <= ? THEN 1 ELSE 0 END) rugged
       FROM called_nft_collections
       WHERE LOWER(deployer_address) = LOWER(?)
         AND controller_kind = ?
         AND ${settled} IS NOT NULL`
    )
    .get(ruggedBelowPct, controllerAddress, kind);
  if (!row || row.n === 0) {
    return { collections: 0, rugged: 0, ruggedRatio: null, avgPct: null, worstPct: null };
  }
  return {
    collections: row.n,
    rugged: row.rugged,
    ruggedRatio: row.rugged / row.n,
    avgPct: row.avgPct,
    worstPct: row.worstPct,
  };
}

// One wallet's aggregate copy-trade track record — only counts calls with
// a resolved outcome (outcome_checked_at set). Null fields (not "0 signals
// yet") when nothing has resolved, so callers can tell "no data" apart
// from "0% win rate."
export function getWalletTrackRecord(walletAddress) {
  const row = db
    .prepare(
      `SELECT COUNT(*) n, AVG(outcome_pct) avgPct, SUM(CASE WHEN outcome_pct > 0 THEN 1 ELSE 0 END) wins
       FROM called_nft_collections
       WHERE trigger_wallet_address = ? AND outcome_checked_at IS NOT NULL AND outcome_pct IS NOT NULL`
    )
    .get(walletAddress.toLowerCase());
  if (!row || row.n === 0) return { signals: 0, avgPct: null, winRate: null };
  return { signals: row.n, avgPct: row.avgPct, winRate: row.wins / row.n };
}

// All watched wallets' track records in one query (grouped) — used by the
// Watched Wallets list so it doesn't run one query per wallet.
export function getAllWalletTrackRecords() {
  const rows = db
    .prepare(
      `SELECT trigger_wallet_address AS address, COUNT(*) n, AVG(outcome_pct) avgPct, SUM(CASE WHEN outcome_pct > 0 THEN 1 ELSE 0 END) wins
       FROM called_nft_collections
       WHERE trigger_wallet_address IS NOT NULL AND outcome_checked_at IS NOT NULL AND outcome_pct IS NOT NULL
       GROUP BY trigger_wallet_address`
    )
    .all();
  const map = new Map();
  for (const row of rows) {
    map.set(row.address, { signals: row.n, avgPct: row.avgPct, winRate: row.wins / row.n });
  }
  return map;
}

export function getWatchedWallets() {
  return db.prepare("SELECT * FROM watched_wallets ORDER BY added_at ASC").all();
}

export function addWatchedWallet(address, label) {
  db.prepare(
    `INSERT INTO watched_wallets (address, label, added_at) VALUES (?, ?, ?)
     ON CONFLICT(address) DO UPDATE SET label = excluded.label`
  ).run(address.toLowerCase(), label || null, Date.now());
}

export function removeWatchedWallet(address) {
  const res = db.prepare("DELETE FROM watched_wallets WHERE address = ?").run(address.toLowerCase());
  return res.changes > 0;
}

export function hasNftCopySignal(txHash, walletAddress, contractAddress) {
  return !!db
    .prepare("SELECT 1 FROM nft_copy_signals WHERE tx_hash = ? AND wallet_address = ? AND contract_address = ?")
    .get(txHash, walletAddress, contractAddress);
}

export function recordNftCopySignal({ walletAddress, contractAddress, tokenId, txHash }) {
  db.prepare(
    `INSERT OR IGNORE INTO nft_copy_signals (wallet_address, contract_address, token_id, tx_hash, detected_at)
     VALUES (?, ?, ?, ?, ?)`
  ).run(walletAddress, contractAddress, tokenId ?? null, txHash, Date.now());
}

export function addNftPendingListing({ chain, contractAddress, calledAt }) {
  db.prepare(
    `INSERT OR IGNORE INTO nft_pending_listings (chain, contract_address, called_at, last_checked_at, attempts)
     VALUES (?, ?, ?, ?, 0)`
  ).run(chain, contractAddress, calledAt, calledAt);
}

export function getAllNftPendingListings() {
  return db.prepare("SELECT * FROM nft_pending_listings").all();
}

export function touchNftPendingListing(id) {
  db.prepare("UPDATE nft_pending_listings SET last_checked_at = ?, attempts = attempts + 1 WHERE id = ?").run(Date.now(), id);
}

export function removeNftPendingListing(id) {
  db.prepare("DELETE FROM nft_pending_listings WHERE id = ?").run(id);
}

export function openNftPaperTrade(entry) {
  const stmt = db.prepare(`
    INSERT INTO nft_paper_trades
      (chain, contract_address, token_id, collection_slug, name, entry_price_eth,
       target_multiple, stop_floor_pct, entry_at, last_checked_at, status)
    VALUES (@chain, @contractAddress, @tokenId, @collectionSlug, @name, @entryPriceEth,
       @targetMultiple, @stopFloorPct, @entryAt, @entryAt, 'open')
    ON CONFLICT(chain, contract_address, token_id) DO NOTHING
  `);
  return stmt.run(entry);
}

export function getOpenNftPaperTrades() {
  return db.prepare("SELECT * FROM nft_paper_trades WHERE status IN ('open', 'listed')").all();
}

export function markNftPaperTradeListed(id, { listedPriceEth, listedAt }) {
  db.prepare("UPDATE nft_paper_trades SET status = 'listed', listed_price_eth = ?, listed_at = ?, last_checked_at = ? WHERE id = ?").run(
    listedPriceEth,
    listedAt,
    listedAt,
    id
  );
}

export function touchNftPaperTrade(id) {
  db.prepare("UPDATE nft_paper_trades SET last_checked_at = ? WHERE id = ?").run(Date.now(), id);
}

export function closeNftPaperTrade(id, { exitPriceEth, exitReason, pnlEth, pnlPct }) {
  db.prepare(
    `UPDATE nft_paper_trades
     SET status = 'closed', exit_price_eth = ?, exit_at = ?, exit_reason = ?, pnl_eth = ?, pnl_pct = ?, last_checked_at = ?
     WHERE id = ?`
  ).run(exitPriceEth, Date.now(), exitReason, pnlEth, pnlPct, Date.now(), id);
}

export function getNftPaperTradingStats() {
  const open = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(entry_price_eth), 0) deployed FROM nft_paper_trades WHERE status IN ('open', 'listed')").get();
  const closed = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(pnl_eth), 0) totalPnl FROM nft_paper_trades WHERE status = 'closed'").get();
  const wins = db.prepare("SELECT COUNT(*) n FROM nft_paper_trades WHERE status = 'closed' AND pnl_pct >= 0").get().n;
  return {
    openCount: open.n,
    deployedEth: open.deployed,
    closedCount: closed.n,
    totalPnlEth: closed.totalPnl,
    wins,
    winRate: closed.n > 0 ? wins / closed.n : null,
  };
}

// --- nft_real_trades: same shape and lifecycle as nft_paper_trades, plus the
// on-chain execution fields a real fill has and a simulated one does not
// (tx hashes, gas).
export function openNftRealTrade(entry) {
  const stmt = db.prepare(`
    INSERT INTO nft_real_trades
      (chain, contract_address, token_id, collection_slug, name, entry_price_eth,
       target_multiple, stop_floor_pct, entry_at, last_checked_at, status,
       entry_tx_hash, entry_gas_eth)
    VALUES (@chain, @contractAddress, @tokenId, @collectionSlug, @name, @entryPriceEth,
       @targetMultiple, @stopFloorPct, @entryAt, @entryAt, 'open',
       @entryTxHash, @entryGasEth)
    ON CONFLICT(chain, contract_address, token_id) DO NOTHING
  `);
  return stmt.run(entry);
}

export function getOpenNftRealTrades() {
  return db.prepare("SELECT * FROM nft_real_trades WHERE status IN ('open', 'listed')").all();
}

export function getOpenNftRealTradeByToken(chain, contractAddress, tokenId) {
  return db
    .prepare("SELECT * FROM nft_real_trades WHERE chain = ? AND contract_address = ? AND token_id = ? AND status IN ('open', 'listed')")
    .get(chain, contractAddress, tokenId);
}

export function markNftRealTradeListed(id, { listedPriceEth, listedAt, listingOrderHash }) {
  db.prepare(
    "UPDATE nft_real_trades SET status = 'listed', listed_price_eth = ?, listed_at = ?, listing_order_hash = ?, last_checked_at = ? WHERE id = ?"
  ).run(listedPriceEth, listedAt, listingOrderHash, listedAt, id);
}

export function touchNftRealTrade(id) {
  db.prepare("UPDATE nft_real_trades SET last_checked_at = ? WHERE id = ?").run(Date.now(), id);
}

export function closeNftRealTrade(id, { exitPriceEth, exitReason, pnlEth, pnlPct, exitTxHash, exitGasEth }) {
  db.prepare(
    `UPDATE nft_real_trades
     SET status = 'closed', exit_price_eth = ?, exit_at = ?, exit_reason = ?, pnl_eth = ?, pnl_pct = ?,
         last_checked_at = ?, exit_tx_hash = ?, exit_gas_eth = ?
     WHERE id = ?`
  ).run(exitPriceEth, Date.now(), exitReason, pnlEth, pnlPct, Date.now(), exitTxHash, exitGasEth, id);
}

export function getNftRealTradingStats() {
  const open = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(entry_price_eth), 0) deployed FROM nft_real_trades WHERE status IN ('open', 'listed')").get();
  const closed = db.prepare("SELECT COUNT(*) n, COALESCE(SUM(pnl_eth), 0) totalPnl FROM nft_real_trades WHERE status = 'closed'").get();
  const wins = db.prepare("SELECT COUNT(*) n FROM nft_real_trades WHERE status = 'closed' AND pnl_pct >= 0").get().n;
  return {
    openCount: open.n,
    deployedEth: open.deployed,
    closedCount: closed.n,
    totalPnlEth: closed.totalPnl,
    wins,
    winRate: closed.n > 0 ? wins / closed.n : null,
  };
}

// ── Contract creator cache ────────────────────────────────────────────────
//
// See the table comment: a creator never changes, so this converts a per
// evaluation explorer call into a once-per-contract one. Addresses are stored
// lowercased so a checksum-cased lookup cannot miss a row it wrote itself.

export function getCachedContractCreator(chain, contractAddress) {
  const row = db
    .prepare(`SELECT creator_address, creation_tx, found_at FROM contract_creators WHERE chain = ? AND contract_address = ?`)
    .get(chain, String(contractAddress).toLowerCase());
  if (!row) return null;
  return { deployerAddress: row.creator_address, creationTx: row.creation_tx, foundAt: row.found_at };
}

export function cacheContractCreator(chain, contractAddress, { deployerAddress, creationTx = null }) {
  if (!deployerAddress) return false;
  db.prepare(
    `INSERT INTO contract_creators (chain, contract_address, creator_address, creation_tx, found_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(chain, contract_address) DO NOTHING`
  ).run(chain, String(contractAddress).toLowerCase(), deployerAddress, creationTx, Date.now());
  return true;
}

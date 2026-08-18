import fetch from "node-fetch";
import { config } from "../config.js";

const BASE_URL = "https://api.etherscan.io/v2/api";

async function getContractCreatorFromEtherscan(etherscanChainId, tokenAddress) {
  if (!config.etherscanApiKey) return { ok: false, reason: "no_api_key" };

  const params = new URLSearchParams({
    chainid: String(etherscanChainId),
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: tokenAddress,
    apikey: config.etherscanApiKey,
  });

  const res = await fetch(`${BASE_URL}?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Etherscan API error ${res.status}: ${await res.text()}`);
  const body = await res.json();

  if (body.status !== "1") {
    // Etherscan's actual wording for an unrecognized chainid is "unsupported
    // chainid parameter" (confirmed live for Robinhood Chain's 4663) — the
    // original "not supported" match missed this ("unsupported" doesn't
    // contain that substring), misclassifying it as "not_found" instead of
    // "unsupported_chain" and silently skipping the Blockscout fallback below.
    const reason = /not supported|unsupported|upgrade your api plan/i.test(`${body.result} ${body.message}`)
      ? "unsupported_chain"
      : "not_found";
    return { ok: false, reason };
  }
  if (!Array.isArray(body.result) || body.result.length === 0) return { ok: false, reason: "not_found" };

  return {
    ok: true,
    deployerAddress: body.result[0].contractCreator,
    creationTxHash: body.result[0].txHash,
  };
}

// Blockscout instances expose the same Etherscan-shaped API for free,
// unauthenticated, at /api?module=...&action=... — verified live against
// robinhoodchain.blockscout.com (module=contract&action=getcontractcreation
// returned a real deployer address for a token Etherscan V2 doesn't cover at
// all). Used as a fallback for chains chains.js gives a blockscoutBaseUrl,
// so deployer-history tracking (scoreDeployerHistory below) isn't
// permanently blind on chains outside Etherscan's coverage.
// Blockscout's free tier rate-limits, and a burst is exactly what this bot
// produces: the collection watcher hands over a whole poll cycle at once
// (107 collections on one startup, observed 2026-08-18), each wanting a
// deployer lookup. Every one past the limit came back 429, got swallowed by
// the catch in getContractCreator as a generic "error", and scored
// NO_DATA_FACTOR — the deployer graph quietly collecting nothing under load,
// which is the failure mode it can least afford.
//
// One retry on 429, honouring Retry-After when the server sends it. This
// does not fix sustained overload — only a real limiter would, and that is
// worth doing if backfills stay this large — but it recovers the common case
// where a burst briefly crosses the line.
// Per-host serialized queue with minimum spacing, same shape as the OpenSea
// limiter in opensea.js and for the same reason: pacing per-caller doesn't
// compose, only one place that sees every request knows the true rate.
//
// Per HOST, not global, because Base and Robinhood are separate Blockscout
// deployments. Serializing them into one queue would halve throughput for
// two quotas that are counted independently.
//
// Measured against both instances 2026-08-18, unauthenticated:
//   x-ratelimit-limit: 10, x-ratelimit-reset ~1.57e6 (ms => ~26 min)
// and once exhausted EVERY request 429s regardless of spacing — 0/12 at
// 0ms, 250ms and 1100ms alike. So the ceiling is a long-window quota, not a
// rate this can pace under. Spacing below is therefore about not burning the
// quota faster than necessary and not hammering a limit already blown; it is
// NOT sufficient on its own. See getContractCreator's note on what is.
const MIN_REQUEST_SPACING_MS = 1100;

// How long to stop asking a host after it says no. Nothing tells us when the
// window actually rolls over — x-ratelimit-reset is unlabelled and the two
// hosts report near-identical values, so it is not trustworthy as a
// deadline. A flat cooldown that is clearly shorter than the observed ~26
// minute window means we retry too early rather than sleep through a
// recovery, and each probe costs one request.
const COOLDOWN_MS = 5 * 60 * 1000;

const hostState = new Map(); // host -> { chain: Promise, lastAt: number, cooldownUntil: number }

function stateFor(host) {
  if (!hostState.has(host)) hostState.set(host, { chain: Promise.resolve(), lastAt: 0, cooldownUntil: 0 });
  return hostState.get(host);
}

// Fail fast while a host is cooling down. This is the property that matters
// most in the pipeline: the collection watcher hands over a whole poll cycle
// at once, and a queue that politely waits its turn behind 100 doomed
// requests would stall scoring for minutes. Better to answer "no deployer
// data right now" immediately and let the score degrade honestly.
function isCoolingDown(host) {
  return Date.now() < stateFor(host).cooldownUntil;
}

function noteRateLimited(host) {
  const s = stateFor(host);
  s.cooldownUntil = Date.now() + COOLDOWN_MS;
  console.error(`[explorer] ${host} rate-limited — pausing deployer lookups there for ${COOLDOWN_MS / 60000}m`);
}

function throttled(host, fn) {
  const s = stateFor(host);
  const run = s.chain.then(async () => {
    const wait = s.lastAt + MIN_REQUEST_SPACING_MS - Date.now();
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    s.lastAt = Date.now();
    return fn();
  });
  // Anchor on settled, not fulfilled — one failure must not wedge the queue.
  s.chain = run.catch(() => {});
  return run;
}

async function blockscoutFetch(host, url) {
  return throttled(host, async () => {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    // Trust the counter when it is exposed: remaining 0 means the next
    // request is already doomed, so start cooling now instead of spending
    // one more to be told.
    const remaining = Number(res.headers.get("x-ratelimit-remaining"));
    if (res.status === 429 || remaining === 0) noteRateLimited(host);
    return res;
  });
}

async function getContractCreatorFromBlockscout(blockscoutBaseUrl, tokenAddress) {
  if (isCoolingDown(blockscoutBaseUrl)) return { ok: false, reason: "rate_limited" };

  const params = new URLSearchParams({
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: tokenAddress,
  });
  const res = await blockscoutFetch(blockscoutBaseUrl, `${blockscoutBaseUrl}/api?${params}`);
  // Distinguish "we were throttled" from "this contract has no creation
  // record". Both used to land as a bare throw and then "error", which made
  // a rate limit indistinguishable from a genuine miss in every log.
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  if (!res.ok) throw new Error(`Blockscout API error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  // A brand-new contract legitimately returns an empty result: the indexer
  // has not caught up yet. That is the normal state for a mint we would
  // underwrite, so it is "not_found", not a failure.
  if (!Array.isArray(body.result) || body.result.length === 0) return { ok: false, reason: "not_found" };
  return {
    ok: true,
    deployerAddress: body.result[0].contractCreator,
    creationTxHash: body.result[0].txHash,
  };
}

// Looks up who deployed the token contract — tries Etherscan V2 first
// (requires ETHERSCAN_API_KEY; only covers a subset of chains), falling
// back to the chain's own Blockscout instance when Etherscan doesn't cover
// it and chains.js has one configured. `reason` lets callers tell "not
// supported on this plan" apart from "genuinely not found" instead of
// silently treating both the same way.
//
// KNOWN CEILING, and the limiter above does not raise it. Unauthenticated
// Blockscout allows ~10 requests per ~26 minute window per host. This bot's
// collection watcher can hand over 100+ contracts from a single poll cycle,
// so on a busy chain most lookups will return rate_limited and the deployer
// category will score NO_DATA. The limiter stops the hammering and makes the
// failure legible; it cannot create quota.
//
// Two things actually raise it, neither of which is a code change here:
//   1. A Blockscout API key (the 429 body links dev.blockscout.com) or an
//      Etherscan plan that covers Base — the direct fix.
//   2. Not needing an indexer at all. Most NFT contracts expose owner(),
//      one cheap eth_call with no quota, and for underwriting purposes the
//      party who can pull the levers today is arguably a better reputation
//      key than whoever deployed the bytecode. It is a different key with
//      different semantics though — owner can be transferred, deployer
//      cannot — so that is a deliberate design call, not a fallback to
//      slip in quietly.
export async function getContractCreator(chain, tokenAddress) {
  const result = await getContractCreatorFromEtherscan(chain.etherscanChainId, tokenAddress);
  if (result.ok || !chain.blockscoutBaseUrl) return result;
  if (result.reason !== "unsupported_chain" && result.reason !== "no_api_key") return result;
  return getContractCreatorFromBlockscout(chain.blockscoutBaseUrl, tokenAddress).catch(() => ({ ok: false, reason: "error" }));
}

async function getDeployerTxCountFromEtherscan(etherscanChainId, deployerAddress) {
  if (!config.etherscanApiKey) return null;

  const params = new URLSearchParams({
    chainid: String(etherscanChainId),
    module: "account",
    action: "txlist",
    address: deployerAddress,
    sort: "asc",
    apikey: config.etherscanApiKey,
  });

  const res = await fetch(`${BASE_URL}?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Etherscan API error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (body.status !== "1" || !Array.isArray(body.result)) return null;

  const contractCreations = body.result.filter((tx) => tx.to === "" || tx.to === null).length;
  return { txCount: body.result.length, contractCreations };
}

async function getDeployerTxCountFromBlockscout(blockscoutBaseUrl, deployerAddress) {
  const params = new URLSearchParams({
    module: "account",
    action: "txlist",
    address: deployerAddress,
    sort: "asc",
  });
  const res = await fetch(`${blockscoutBaseUrl}/api?${params}`, { signal: AbortSignal.timeout(20000) });
  if (!res.ok) throw new Error(`Blockscout API error ${res.status}: ${await res.text()}`);
  const body = await res.json();
  if (!Array.isArray(body.result)) return null;

  const contractCreations = body.result.filter((tx) => tx.to === "" || tx.to === null).length;
  return { txCount: body.result.length, contractCreations };
}

// Counts how many contracts a deployer address has created (proxy for
// "serial token deployer" behavior often seen in rug patterns) — same
// Etherscan-then-Blockscout fallback as getContractCreator above.
export async function getDeployerTxCount(chain, deployerAddress) {
  const fromEtherscan = await getDeployerTxCountFromEtherscan(chain.etherscanChainId, deployerAddress);
  if (fromEtherscan || !chain.blockscoutBaseUrl) return fromEtherscan;
  return getDeployerTxCountFromBlockscout(chain.blockscoutBaseUrl, deployerAddress).catch(() => null);
}

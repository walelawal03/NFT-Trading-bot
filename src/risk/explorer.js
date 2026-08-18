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
const RETRY_AFTER_FALLBACK_MS = 1500;

async function blockscoutFetch(url, attempt = 0) {
  const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
  if (res.status !== 429 || attempt > 0) return res;

  const header = Number(res.headers.get("retry-after"));
  const waitMs = Number.isFinite(header) && header > 0 ? Math.min(header * 1000, 10000) : RETRY_AFTER_FALLBACK_MS;
  await new Promise((r) => setTimeout(r, waitMs));
  return blockscoutFetch(url, attempt + 1);
}

async function getContractCreatorFromBlockscout(blockscoutBaseUrl, tokenAddress) {
  const params = new URLSearchParams({
    module: "contract",
    action: "getcontractcreation",
    contractaddresses: tokenAddress,
  });
  const res = await blockscoutFetch(`${blockscoutBaseUrl}/api?${params}`);
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

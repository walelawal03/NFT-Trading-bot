import { Wallet, formatEther } from "ethers";
import { config } from "./config.js";
import { CHAINS } from "./chains.js";
import { FailoverProvider } from "./rpc.js";
import { loadWalletPrivateKey } from "./walletSettings.js";

// Per-chain HTTP providers, built lazily and cached. Real trading needs
// eth_sendRawTransaction (write), which the existing per-chain WSS RPCs
// also support over their HTTP form — reusing the same endpoints rather
// than requiring separate config.
const providerCache = new Map();
const logProviderCache = new Map();

function derivedHttpFromWss(chain) {
  const wss = chain.wssEnvVar ? process.env[chain.wssEnvVar] : null;
  if (!wss) return null;
  return wss.replace(/^wss:\/\//, "https://").replace(/^ws:\/\//, "http://");
}

function dedupe(candidates) {
  const urls = [];
  for (const candidate of candidates) {
    const url = candidate?.trim();
    if (url && !urls.includes(url)) urls.push(url);
  }
  return urls;
}

// Every endpoint this chain may use for ordinary reads and for trade
// execution, best first. Later entries are only ever consulted when an
// earlier one fails to answer (see FailoverProvider).
//
// Precedence puts explicitly-configured endpoints ahead of the built-in
// defaults, so a paid/private RPC in the env is always the one that builds
// nonces and broadcasts transactions — the defaults exist to keep the bot
// working when that endpoint is having a bad minute, not to quietly override
// a deliberate choice.
export function httpUrlsFor(chain) {
  const configured = chain.httpEnvVar ? process.env[chain.httpEnvVar] : null;
  const urls = dedupe([
    ...(configured ? configured.split(",") : []),
    chain.httpRpcUrl,
    ...(chain.httpRpcUrls || []),
    derivedHttpFromWss(chain),
  ]);
  if (!urls.length) throw new Error(`No RPC configured for ${chain.key} (${chain.httpEnvVar || chain.wssEnvVar})`);
  return urls;
}

// Kept for callers that genuinely want a single URL (logging, diagnostics).
export function httpUrlFor(chain) {
  return httpUrlsFor(chain)[0];
}

// Log polling is a separate list because eth_getLogs support is the one
// capability free endpoints disagree about most — on BSC the split is total,
// with the only endpoint that answers log queries being the same one that
// refuses transaction receipts. See the tables in chains.js.
export function logRpcUrlsFor(chain) {
  const urls = dedupe([...(chain.logRpcUrls || []), ...httpUrlsFor(chain)]);
  return urls;
}

// etherscanChainId is the plain EVM chain id — Etherscan's V2 API keys its
// chains by exactly that number, so the field does double duty rather than
// carrying the same value twice under two names. Passing it through pins the
// network on every provider so none of them ever needs to ask.
const evmChainId = (chain) => chain.etherscanChainId;

export function getProvider(chain) {
  if (!providerCache.has(chain.key)) {
    providerCache.set(chain.key, new FailoverProvider(httpUrlsFor(chain), chain.key, evmChainId(chain)));
  }
  return providerCache.get(chain.key);
}

export function getLogProvider(chain) {
  if (!logProviderCache.has(chain.key)) {
    logProviderCache.set(chain.key, new FailoverProvider(logRpcUrlsFor(chain), `${chain.key}/logs`, evmChainId(chain)));
  }
  return logProviderCache.get(chain.key);
}

// The persisted store (set via Telegram — /wallet create or import) takes
// priority over the WALLET_PRIVATE_KEY env var, so changing it live never
// needs a redeploy. Re-read on every call rather than cached at module load,
// since it can change at any time while the bot is running.
function currentPrivateKey() {
  return loadWalletPrivateKey() || config.walletPrivateKey || null;
}

// Returns a Wallet connected to the given chain, or null if no private key
// is configured — callers must treat null as "real trading unavailable",
// never fall back to a dummy signer.
export function getWalletForChain(chain) {
  const privateKey = currentPrivateKey();
  if (!privateKey) return null;
  return new Wallet(privateKey, getProvider(chain));
}

export function hasWallet() {
  return Boolean(currentPrivateKey());
}

export function getWalletAddress() {
  const privateKey = currentPrivateKey();
  if (!privateKey) return null;
  return new Wallet(privateKey).address;
}

// Deliberately named distinctly from the getters above — this hands back the
// raw private key, not just an address. Only for the Telegram wallet-reveal
// flow (admin + passcode gated there), never for anything on a hot path.
export function getPrivateKeyForExport() {
  return currentPrivateKey();
}

export async function getNativeBalance(chain) {
  const wallet = getWalletForChain(chain);
  if (!wallet) return null;
  const raw = await getProvider(chain).getBalance(wallet.address);
  return Number(formatEther(raw));
}

// ENS resolution always goes through Ethereum mainnet (the ENS registry
// lives there, regardless of which chain the resolved address is later
// watched/traded on — an address is the same across every EVM chain). Used
// by the NFT wallet-copy-trade "Add Wallet" flow so a watched wallet can be
// entered as a human-readable .eth name instead of a raw address. Returns
// null (not a throw) if the name doesn't resolve, so callers can give a
// clean "couldn't resolve that name" reply instead of a stack trace.
export async function resolveEnsName(name) {
  const provider = getProvider({ key: "ethereum", ...CHAINS.ethereum });
  return provider.resolveName(name.toLowerCase()).catch(() => null);
}

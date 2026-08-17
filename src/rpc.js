import { JsonRpcProvider, Network } from "ethers";

// Errors that mean "the chain itself answered, and the answer was no" — a
// revert, a spent nonce, an underfunded wallet. Every other node would give
// the identical reply, so asking one is a wasted round trip and, worse,
// delays surfacing a real problem. Everything NOT listed here is treated as
// "this particular node couldn't serve me", which is what failover is for.
//
// The case that motivated this list: publicnode's free tier answers
// eth_getTransactionReceipt with a non-standard JSON-RPC error, which ethers
// can't map onto any of its own codes and reports as UNKNOWN_ERROR wrapped in
// "could not coalesce error". That must be retryable — it says nothing about
// the transaction, only about the endpoint.
const NON_RETRYABLE_ERROR_CODES = new Set([
  "CALL_EXCEPTION",
  "INSUFFICIENT_FUNDS",
  "NONCE_EXPIRED",
  "REPLACEMENT_UNDERPRICED",
  "TRANSACTION_REPLACED",
  "ACTION_REJECTED",
  "UNCONFIGURED_NAME",
]);

function isRetryable(err) {
  return !NON_RETRYABLE_ERROR_CODES.has(err?.code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Pause before the final re-ask of the primary. The failure this exists for
// is a rate/tier gate rather than an outage, so a short breath is usually
// enough — but only after the backups have already had their turn.
const PRIMARY_RETRY_DELAY_MS = 300;

// A JsonRpcProvider that re-asks a different endpoint when the one it asked
// couldn't answer. Deliberately sequential and primary-first rather than
// ethers' own FallbackProvider, which is built for a different problem:
// FallbackProvider seeks agreement between nodes (default quorum is half the
// providers), so it fans every request out to several endpoints and, at
// quorum 1, will happily return the first node's *error* as the winning
// answer — precisely the behaviour being fixed here. It also means nonce and
// block-height reads can land on whichever node replies first, which is not
// something a trading bot wants drifting between endpoints.
//
// Here the primary is always preferred and only genuinely-stuck requests move
// on, so reads stay consistent with the endpoint used to build and send
// transactions.
export class FailoverProvider extends JsonRpcProvider {
  #backups;
  #urls;
  #label;
  #network;

  // chainId is required rather than detected. Every url in the list serves
  // the same chain by construction, so pinning the network up front means no
  // provider here ever issues eth_chainId — which matters more than the saved
  // round trip: ethers' network detection, once it starts and fails, retries
  // in a loop forever and logs on every pass. A backup that only exists for
  // the rare bad minute would otherwise sit there detecting against an
  // endpoint nobody is using, filling the log with "failed to detect network"
  // long after the request it was created for succeeded elsewhere.
  constructor(urls, label, chainId) {
    const network = chainId != null ? Network.from(Number(chainId)) : undefined;
    super(urls[0], network, network ? { staticNetwork: network } : undefined);
    this.#urls = urls;
    this.#label = label;
    this.#network = network;
    this.#backups = new Array(urls.length - 1).fill(null);
  }

  get rpcUrls() {
    return [...this.#urls];
  }

  // Backups are built on first use, not up front: most of them are never
  // needed at all, and an unused provider should cost nothing — no socket, no
  // detection, no log noise. Batching is disabled on them because they get
  // one-off requests where batching buys nothing, and some of these public
  // endpoints handle batched payloads noticeably worse than single ones.
  #backupAt(slot) {
    if (!this.#backups[slot]) {
      this.#backups[slot] = new JsonRpcProvider(this.#urls[slot + 1], this.#network, {
        staticNetwork: this.#network,
        batchMaxCount: 1,
      });
    }
    return this.#backups[slot];
  }

  // Total attempts: the primary, then each backup in order, then the primary
  // once more. Index 0 and the final index are both the primary.
  #providerFor(index) {
    if (index === 0 || index > this.#backups.length) return null; // null = primary (super)
    return this.#backupAt(index - 1);
  }

  async _perform(req) {
    // Handing a signed transaction to a second endpoint is not "asking the
    // same question again" — it is a second broadcast. The duplicate is
    // harmless on-chain (identical hash, already in a mempool) but the second
    // node replies "already known", which would surface as a failure on a
    // send that actually succeeded. That confusion between "the send failed"
    // and "I couldn't read the answer" is the whole bug this file exists to
    // remove, so don't reintroduce it here.
    if (req.method === "broadcastTransaction") return super._perform(req);

    const totalAttempts = this.#backups.length + 2;
    let firstErr;

    for (let i = 0; i < totalAttempts; i++) {
      const isFinalPrimaryRetry = i === totalAttempts - 1;
      if (isFinalPrimaryRetry) await sleep(PRIMARY_RETRY_DELAY_MS);

      const backup = this.#providerFor(i);
      try {
        const result = backup ? await backup._perform(req) : await super._perform(req);
        if (i > 0) {
          const via = backup ? this.#urls[i] : `${this.#urls[0]} (retry)`;
          console.warn(`[rpc/${this.#label}] ${req.method} failed on ${this.#urls[0]}, served by ${via}`);
        }
        return result;
      } catch (err) {
        firstErr ??= err;
        if (!isRetryable(err)) throw err;
      }
    }

    // Every endpoint refused. Report the primary's own error rather than
    // whichever backup happened to fail last — the primary is the endpoint
    // actually configured for this chain, so its complaint is the one worth
    // acting on (the backups may simply not support this method at all).
    throw firstErr;
  }

  destroy() {
    for (const backup of this.#backups) backup?.destroy();
    super.destroy();
  }
}

import { Contract, Interface, Wallet, formatEther, parseEther } from "ethers";
import { loadMintWalletSigningKeys, listMintWallets } from "./mintWallets.js";
import { loadMintExecutionSettings } from "./mintExecutionSettings.js";
import { getProvider } from "../wallet.js";
import { SEADROP_1_0 } from "./nftMintDetect.js";

// Builds and simulates a mint. It does NOT send one.
//
// Deliberately split that way. Constructing the call correctly — right
// target, right value, right fee recipient — is where a mint actually goes
// wrong, and all of it can be verified without spending anything. Signing is
// a separate step that can be added on top of code already proven to produce
// the right transaction.
//
// Nothing in this module reads a private key.

const SEADROP_IFACE = new Interface([
  "function mintPublic(address nftContract, address feeRecipient, address minterIfNotPayer, uint256 quantity) payable",
]);

const SEADROP_VIEW_ABI = [
  "function getAllowedFeeRecipients(address) view returns (address[])",
];

// address(0) tells SeaDrop the payer is the minter. Passing the minter's own
// address here instead makes SeaDrop treat the caller as a payer minting on
// someone else's behalf, which requires the payer to be registered and
// reverts when it isn't.
const MINTER_IS_PAYER = "0x0000000000000000000000000000000000000000";

/**
 * Resolves the fee recipient the mint must pay.
 *
 * When restrictFeeRecipients is set — it is on every OpenSea-configured drop
 * seen so far — SeaDrop reverts for any recipient not on the allowlist, so
 * this is not a preference we get to make. Returns null when the list can't
 * be read, and callers must treat that as "cannot build the mint" rather
 * than substituting an address of their own.
 */
export async function resolveFeeRecipient(chain, contractAddress) {
  const seadrop = new Contract(SEADROP_1_0, SEADROP_VIEW_ABI, getProvider(chain));
  const allowed = await seadrop.getAllowedFeeRecipients(contractAddress).catch(() => null);
  if (!allowed || allowed.length === 0) return null;
  return allowed[0];
}

/**
 * The exact transaction a mint would send.
 *
 * value is quantity * unit price with no fee added: SeaDrop's
 * _checkCorrectPayment requires msg.value == quantity * mintPrice EXACTLY,
 * and feeBps only decides how that payment is split afterwards. Adding the
 * fee on top reverts just as surely as underpaying does.
 */
export function buildSeaDropMintCall({ contractAddress, feeRecipient, quantity, unitPriceWei }) {
  if (!feeRecipient) throw new Error("No allowed fee recipient — cannot build a SeaDrop mint");
  if (unitPriceWei == null) throw new Error("Unit price unknown — refusing to build a mint with an assumed price");
  if (!Number.isInteger(quantity) || quantity < 1) throw new Error(`Invalid quantity: ${quantity}`);

  return {
    to: SEADROP_1_0,
    data: SEADROP_IFACE.encodeFunctionData("mintPublic", [contractAddress, feeRecipient, MINTER_IS_PAYER, quantity]),
    value: unitPriceWei * BigInt(quantity),
  };
}

/**
 * Builds the call for whatever standard this collection uses.
 *
 * Refuses rather than guesses. A mint built against the wrong standard is not
 * a degraded mint, it is a transaction that burns gas to revert — and at a
 * launch that is the moment you cannot afford to spend re-learning.
 */
export async function buildMintCall(chain, { detect, contractAddress, quantity, priceOverrideWei = null }) {
  const unitPriceWei = priceOverrideWei ?? detect.phase?.priceWei ?? null;

  if (detect.standard === "seadrop") {
    const feeRecipient = await resolveFeeRecipient(chain, contractAddress);
    return buildSeaDropMintCall({ contractAddress, feeRecipient, quantity, unitPriceWei });
  }

  if (detect.standard === "direct" && detect.mintVia) {
    if (unitPriceWei == null) throw new Error("Unit price unknown — refusing to build a mint with an assumed price");
    const iface = new Interface([`function ${detect.mintVia.signature} payable`]);
    const fn = detect.mintVia.signature.split("(")[0];
    // Only the quantity-taking forms are supported here. mint(address,uint256)
    // needs a recipient, which is the minting wallet — and that is the
    // executor's business, not this function's, so it is refused rather than
    // filled in with a placeholder.
    if (!/^\w+\(uint256\)$/.test(detect.mintVia.signature)) {
      throw new Error(`Unsupported direct mint signature: ${detect.mintVia.signature}`);
    }
    return {
      to: contractAddress,
      data: iface.encodeFunctionData(fn, [quantity]),
      value: unitPriceWei * BigInt(quantity),
    };
  }

  throw new Error(`No supported mint entrypoint (standard: ${detect.standard})`);
}

/**
 * Runs the mint as an eth_call from `from`, without sending it.
 *
 * This is the whole reason to build before signing. A revert here costs
 * nothing and names the reason; the same revert on-chain costs the gas of a
 * failed transaction, and at a launch it also costs the allocation. Every
 * mint should pass through here first.
 */
export async function simulateMint(chain, call, from, { atTimestamp = null } = {}) {
  const provider = getProvider(chain);
  try {
    if (atTimestamp != null) {
      // Simulate at a future block time.
      //
      // Not an optimisation — it is the only way to validate a mint that has
      // not opened yet, and without it the whole scheduled-mint path was dead:
      // prepare() runs 90s before the open, both the simulation and the gas
      // estimate reverted on the drop's own `startTime <= block.timestamp`
      // check, so nothing was ever prepared and fire() always refused. That
      // was not a rare edge — it was every armed mint, and it is why a real
      // scheduled mint had never once fired.
      //
      // eth_call's 4th parameter is a geth extension rather than a standard,
      // so a node may accept and ignore it, or reject it outright. Verified
      // honoured on both Robinhood endpoints 2026-08-19 with bytecode that
      // reverts below a timestamp gate — accepting the parameter is not the
      // same as applying it, so it was tested by behaviour, not by the
      // absence of an error.
      await provider.send("eth_call", [
        { to: call.to, data: call.data, value: "0x" + BigInt(call.value ?? 0n).toString(16), from },
        "latest",
        {},
        { time: "0x" + BigInt(atTimestamp).toString(16) },
      ]);
      return { ok: true, reason: null, simulatedAt: atTimestamp };
    }
    await provider.call({ to: call.to, data: call.data, value: call.value, from });
    return { ok: true, reason: null };
  } catch (err) {
    // ethers surfaces the decoded custom error / revert string here when the
    // node returns one. Kept verbatim: "MintQuantityExceedsMaxMintedPerWallet"
    // tells you to lower the quantity, while a generic failure tells you
    // nothing.
    const reason = err.shortMessage || err.reason || err.message || "reverted";
    return { ok: false, reason };
  }
}

// ── Sending ───────────────────────────────────────────────────────────────
// Everything above this line is read-only. Everything below spends ETH.



/**
 * The most specific error text available, not the most convenient.
 *
 * ethers wraps a JSON-RPC failure it cannot classify as "could not coalesce
 * error", which says nothing and hides a message the node did send. Reporting
 * that verbatim to someone whose mint just failed tells them only that
 * something went wrong — the node usually said exactly what.
 *
 * Digs through the nesting ethers uses, in order of specificity, and falls
 * back to the wrapper only when there is genuinely nothing better.
 */
export function describeSendError(err) {
  const nested =
    err?.error?.message ??
    err?.info?.error?.message ??
    err?.info?.responseBody ??
    err?.cause?.error?.message ??
    err?.cause?.message ??
    null;

  const base = err?.shortMessage ?? err?.message ?? "unknown error";
  if (!nested) return base;
  const text = String(nested).slice(0, 200);
  // When the wrapper is uninformative, lead with what the node said.
  return /coalesce|unknown error/i.test(base) ? text : `${base} — ${text}`;
}

/**
 * Mints across the first `walletCount` wallets in the roster.
 *
 * Order of checks is deliberate — the cheapest and most certain refusals come
 * first, so a misconfigured run costs nothing:
 *
 *   1. execution disabled          (a setting, no network)
 *   2. nothing to mint / no wallets(local state, no network)
 *   3. spend ceiling               (arithmetic, no network)
 *   4. simulation                  (one eth_call, no gas)
 *   5. gas estimate                (no gas)
 *   6. send                        (real money — skipped entirely on dryRun)
 *
 * Wallets are sent CONCURRENTLY. They are independent accounts with
 * independent nonces, and at a launch the difference between first and last
 * is the difference between minting and not. One wallet failing must never
 * hold up the others, so each result is captured rather than thrown.
 */
export async function executeMint(chain, { detect, contractAddress, quantity, priceOverrideWei = null, walletCount }) {
  const settings = loadMintExecutionSettings();
  if (!settings.enabled) {
    return { ok: false, reason: "Mint execution is disabled. Turn it on in mint settings first.", results: [] };
  }

  const keys = loadMintWalletSigningKeys().slice(0, walletCount);
  if (keys.length === 0) return { ok: false, reason: "No wallets imported.", results: [] };
  if (!detect.mintVia) return { ok: false, reason: "No mint entrypoint on this contract.", results: [] };

  // Ceiling first, from the unit price alone — no network. buildMintCall
  // resolves the fee recipient over RPC, so building before checking made an
  // unaffordable run cost a round trip to refuse, and on a slow chain that is
  // seconds spent to say no. The arithmetic needs nothing but the price.
  const unitPriceWei = priceOverrideWei ?? detect.phase?.priceWei ?? null;
  if (unitPriceWei == null) {
    return { ok: false, reason: "Unit price unknown — refusing to mint at an assumed price.", results: [] };
  }
  const totalWei = unitPriceWei * BigInt(quantity) * BigInt(keys.length);
  const ceilingWei = parseEther(String(settings.maxSpendEthPerRun));
  if (totalWei > ceilingWei) {
    return {
      ok: false,
      reason: `Run would spend ${formatEther(totalWei)} ETH, over the ${settings.maxSpendEthPerRun} ETH ceiling.`,
      results: [],
    };
  }

  const call = await buildMintCall(chain, { detect, contractAddress, quantity, priceOverrideWei });

  const provider = getProvider(chain);

  // Price the transaction explicitly, the same way prepareSignedMints does.
  //
  // Left unset, ethers populates EIP-1559 fields and sets maxFeePerGas to
  // roughly twice the base fee. The node then checks the balance against that
  // ceiling, not against what the transaction will actually cost — so a mint
  // that needed 0.000503 ETH was rejected against a 0.000506 balance for
  // wanting 0.000507. Observed exactly that, short by 0.47 microether.
  //
  // maxPriorityFeePerGas is 0 on this chain, so legacy pricing is not
  // underpricing anything; it just stops the balance check reserving headroom
  // that will never be spent.
  // Priced between two failure modes, both of which have happened here.
  //
  // Too low and the node rejects outright: "max fee per gas less than block
  // base fee, maxFeePerGas 20208000 baseFee 20406000" — the base fee ticked
  // up in the seconds between reading it and sending, because the raw
  // gasPrice carried no headroom at all.
  //
  // Too high and the BALANCE check refuses: the node reserves
  // gasLimit * price before execution, so ethers' default EIP-1559 ceiling of
  // twice the base fee rejected a mint the wallet could actually afford, short
  // by 0.47 microether.
  //
  // 1.25x clears ordinary drift while reserving a quarter more than the
  // transaction will spend, rather than double. The unused portion is never
  // charged — overpaying the ceiling costs nothing, being under it costs the
  // mint.
  const feeData = await provider.getFeeData();
  const baseline = feeData.gasPrice ?? feeData.maxFeePerGas ?? null;
  const gasPrice = baseline == null ? null : (baseline * 125n) / 100n;

  const results = await Promise.all(
    keys.map(async (privateKey) => {
      const wallet = new Wallet(privateKey, provider);
      const address = wallet.address;
      try {
        if (settings.requireSimulation) {
          const sim = await simulateMint(chain, call, address);
          // A simulated revert is the cheapest possible failure. Sending
          // anyway burns gas to learn the same thing.
          if (!sim.ok) return { address, ok: false, stage: "simulate", reason: sim.reason };
        }

        // Estimate per wallet rather than once: allowlist state and
        // already-minted counts differ between them, and so does the gas.
        let gasLimit;
        try {
          const estimate = await provider.estimateGas({ ...call, from: address });
          gasLimit = (estimate * BigInt(Math.round(settings.gasLimitMultiplier * 100))) / 100n;
        } catch (err) {
          return { address, ok: false, stage: "estimate", reason: describeSendError(err) };
        }

        // Everything above this line is free. The next statement is not.
        if (settings.dryRun) {
          return { address, ok: true, stage: "dry-run", gasLimit, valueWei: call.value, to: call.to };
        }

        const tx = await wallet.sendTransaction({ ...call, gasLimit, ...(gasPrice != null ? { gasPrice, type: 0 } : {}) });
        return { address, ok: true, stage: "sent", txHash: tx.hash, valueWei: call.value };
      } catch (err) {
        return { address, ok: false, stage: "send", reason: describeSendError(err) };
      }
    })
  );

  return { ok: results.some((r) => r.ok), reason: null, results, call };
}

/**
 * The largest quantity that actually simulates, at or below `maxQuantity`.
 *
 * The advertised cap is not always mintable. Observed live on KITTIHOOD
 * (0x4804547f..., Robinhood): getPublicDrop reports
 * maxTotalMintableByWallet = 6, the wallet had minted 0 of them, and
 * quantities 1-5 simulate fine while 6 reverts — reproducibly, from a funded
 * wallet, on a free mint. Whatever the contract's own reason, the advertised
 * number was wrong and only simulating found it.
 *
 * So SWEEP means "the most that works", not "the most they claim". Binary
 * search rather than stepping down one at a time, because some drops
 * advertise caps in the thousands and each probe is a round trip.
 */
export async function findMaxMintable(chain, { detect, contractAddress, priceOverrideWei = null, from, maxQuantity }) {
  const ceiling = Math.max(1, maxQuantity);

  const works = async (qty) => {
    try {
      const call = await buildMintCall(chain, { detect, contractAddress, quantity: qty, priceOverrideWei });
      return (await simulateMint(chain, call, from)).ok;
    } catch {
      return false;
    }
  };

  // The common case is that the advertised cap is right — check it first so a
  // well-behaved drop costs one probe instead of a whole search.
  if (await works(ceiling)) return ceiling;
  if (!(await works(1))) return 0;

  let lo = 1; // known good
  let hi = ceiling; // known bad
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (await works(mid)) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Does everything except broadcast, and returns signed raw transactions.
 *
 * This is what makes a scheduled mint fast. Measured against Robinhood's
 * public RPC, a fired mint that still has to fetch a nonce, fetch fee data,
 * estimate gas and sign pays ~2.5s before the send even starts. Every one of
 * those is knowable in advance, so the scheduler does them while waiting and
 * fire becomes a single eth_sendRawTransaction — one round trip, which
 * measured 573ms at best on this endpoint. That round trip is the floor; no
 * amount of preparation gets under it.
 *
 * Two things go stale between preparing and firing, and both are deliberate
 * trade-offs rather than oversights:
 *
 *   nonce — signed in, so any OTHER transaction from the same wallet in the
 *           gap invalidates it. Acceptable for a wallet whose only job is
 *           minting; not acceptable for one you also trade from.
 *   fee   — priced at prepare time and padded, because a launch is exactly
 *           when the base fee spikes. Underpriced is worse than overpaid: it
 *           sits unmined while the drop fills.
 */
/**
 * Gas estimate for a call, optionally at a future block time.
 *
 * The timestamp override matters for exactly the same reason it does in
 * simulateMint: estimating a mint that has not opened yet reverts on the
 * drop's own start-time check. Falls back to a plain estimate when a node
 * refuses the override, so a chain without the extension degrades to the old
 * behaviour rather than losing gas estimation entirely.
 */
async function estimateGasAt(provider, call, from, atTimestamp) {
  if (atTimestamp != null) {
    try {
      const hex = await provider.send("eth_estimateGas", [
        { to: call.to, data: call.data, value: "0x" + BigInt(call.value ?? 0n).toString(16), from },
        "latest",
        {},
        { time: "0x" + BigInt(atTimestamp).toString(16) },
      ]);
      return BigInt(hex);
    } catch {
      // Fall through to the plain estimate below, which will most likely
      // revert too — but its revert reason is the useful one to report.
    }
  }
  return provider.estimateGas({ ...call, from });
}

export async function prepareSignedMints(chain, { detect, contractAddress, quantity, priceOverrideWei = null, walletCount, feeMultiplier = 2, atTimestamp = null }) {
  const settings = loadMintExecutionSettings();
  if (!settings.enabled) return { ok: false, reason: "Mint execution is disabled.", signed: [] };

  const keys = loadMintWalletSigningKeys().slice(0, walletCount);
  if (keys.length === 0) return { ok: false, reason: "No wallets imported.", signed: [] };

  const unitPriceWei = priceOverrideWei ?? detect.phase?.priceWei ?? null;
  if (unitPriceWei == null) return { ok: false, reason: "Unit price unknown.", signed: [] };

  const totalWei = unitPriceWei * BigInt(quantity) * BigInt(keys.length);
  const ceilingWei = parseEther(String(settings.maxSpendEthPerRun));
  if (totalWei > ceilingWei) {
    return { ok: false, reason: `Would spend ${formatEther(totalWei)} ETH, over the ${settings.maxSpendEthPerRun} ETH ceiling.`, signed: [] };
  }

  const provider = getProvider(chain);
  const call = await buildMintCall(chain, { detect, contractAddress, quantity, priceOverrideWei });
  const [fee, network] = await Promise.all([provider.getFeeData(), provider.getNetwork()]);

  const mult = BigInt(Math.max(1, Math.round(feeMultiplier)));
  const gasPrice = (fee.gasPrice ?? 0n) * mult;

  const signed = await Promise.all(
    keys.map(async (privateKey) => {
      const wallet = new Wallet(privateKey, provider);
      const address = wallet.address;
      try {
        if (settings.requireSimulation) {
          const sim = await simulateMint(chain, call, address, { atTimestamp });
          if (!sim.ok) return { address, ok: false, stage: "simulate", reason: sim.reason };
        }
        const [nonce, estimate] = await Promise.all([
          provider.getTransactionCount(address, "pending"),
          estimateGasAt(provider, call, address, atTimestamp),
        ]);
        const gasLimit = (estimate * BigInt(Math.round(settings.gasLimitMultiplier * 100))) / 100n;

        const raw = await wallet.signTransaction({
          ...call, nonce, gasLimit, gasPrice, chainId: network.chainId, type: 0,
        });
        return { address, ok: true, raw, nonce, gasLimit, gasPrice, valueWei: call.value };
      } catch (err) {
        return { address, ok: false, stage: "prepare", reason: err.shortMessage || err.message };
      }
    })
  );

  return { ok: signed.some((s) => s.ok), reason: null, signed, call };
}

/**
 * Fires pre-signed transactions. One round trip each, all at once.
 *
 * No reads, no building, no signing — by the time this runs there is nothing
 * left to decide. Concurrent because the wallets are independent and the gap
 * between first and last is the gap between minting and not.
 */
export async function broadcastSigned(chain, signed, { call } = {}) {
  const settings = loadMintExecutionSettings();
  const provider = getProvider(chain);
  const ready = signed.filter((s) => s.ok);

  // A pre-signed transaction carries its nonce in the signature, so anything
  // else the wallet sends between preparing and firing invalidates it. That
  // is not hypothetical: the first wallet imported here turned out to be the
  // token bot's own trading wallet, which had sent four transactions in the
  // preceding hour.
  //
  // Rather than police which wallet is which, recover from it. Fire the
  // pre-signed bytes first — the fast path, one round trip, unchanged in the
  // common case — and only if the node rejects it for a nonce reason, re-sign
  // against a fresh nonce and send again. Costs nothing when nothing moved.
  const isNonceError = (m) => /nonce|already known|replacement transaction underpriced|known transaction/i.test(m || "");

  return Promise.all(
    ready.map(async (s) => {
      if (settings.dryRun) {
        return { address: s.address, ok: true, stage: "dry-run", valueWei: s.valueWei, gasLimit: s.gasLimit };
      }

      const t0 = Date.now();
      try {
        const tx = await provider.broadcastTransaction(s.raw);
        return { address: s.address, ok: true, stage: "sent", txHash: tx.hash, valueWei: s.valueWei, sendMs: Date.now() - t0 };
      } catch (err) {
        const reason = describeSendError(err);
        if (!isNonceError(reason) || !call) {
          return { address: s.address, ok: false, stage: "broadcast", reason };
        }

        // Re-sign against the current nonce. Keys are fetched here rather than
        // carried on the armed entry, so nothing holds key material while a
        // scheduled mint sits waiting.
        try {
          const key = loadMintWalletSigningKeys().find((k) => new Wallet(k).address.toLowerCase() === s.address.toLowerCase());
          if (!key) return { address: s.address, ok: false, stage: "broadcast", reason: `${reason} (wallet no longer in roster)` };

          const wallet = new Wallet(key, provider);
          const nonce = await provider.getTransactionCount(s.address, "pending");
          const tx = await wallet.sendTransaction({ ...call, nonce, gasLimit: s.gasLimit, gasPrice: s.gasPrice });
          return {
            address: s.address, ok: true, stage: "sent-resigned", txHash: tx.hash,
            valueWei: s.valueWei, sendMs: Date.now() - t0, note: `nonce moved (${s.nonce} -> ${nonce}), re-signed`,
          };
        } catch (err2) {
          return { address: s.address, ok: false, stage: "resign", reason: describeSendError(err2) };
        }
      }
    })
  );
}

/**
 * Per-wallet readiness for a specific drop.
 *
 * Answers the four things that actually decide whether a wallet mints, in the
 * order they bite:
 *
 *   balance      — an empty wallet fails at simulation, which reads as
 *                  "reverted" and sends you hunting for a contract problem
 *                  that isn't there. This is by far the most common cause.
 *   already      — SeaDrop's getMintStats reports what this address has
 *                  already taken, so the remaining allowance is knowable
 *                  without guessing.
 *   simulation   — the only thing that catches per-wallet rules nothing
 *                  publishes: allowlists, denylists, caps the contract
 *                  advertises but will not honour.
 *
 * Read-only. No transaction, no gas, and it works before minting is enabled.
 */
export async function checkWalletEligibility(chain, { detect, contractAddress, quantity }) {
  const provider = getProvider(chain);
  const wallets = listMintWallets();
  const unitPriceWei = detect.phase?.priceWei ?? null;

  const STATS_ABI = ["function getMintStats(address) view returns (uint256 minterNumMinted, uint256 currentTotalSupply, uint256 maxSupply)"];
  const stats = detect.standard === "seadrop" ? new Contract(contractAddress, STATS_ABI, provider) : null;

  return Promise.all(
    wallets.map(async (w) => {
      const [balance, minted] = await Promise.all([
        provider.getBalance(w.address).catch(() => null),
        stats ? stats.getMintStats(w.address).then((s) => Number(s[0])).catch(() => null) : Promise.resolve(null),
      ]);

      const cap = detect.phase?.maxPerWallet ?? null;
      const remaining = cap != null && minted != null ? Math.max(0, cap - minted) : null;

      let sim = { ok: null, reason: null };
      try {
        const call = await buildMintCall(chain, { detect, contractAddress, quantity });
        sim = await simulateMint(chain, call, w.address);
      } catch (err) {
        sim = { ok: false, reason: err.shortMessage || err.message };
      }

      // Cost is the mint value only. Gas is separate and tiny by comparison,
      // but a wallet holding exactly the mint price still fails, so the
      // comparison is deliberately "more than", not "at least".
      const needWei = unitPriceWei != null ? unitPriceWei * BigInt(quantity) : null;
      const funded = balance != null && needWei != null ? balance > needWei : balance != null ? balance > 0n : null;

      return { address: w.address, balance, minted, remaining, funded, ok: sim.ok, reason: sim.reason };
    })
  );
}

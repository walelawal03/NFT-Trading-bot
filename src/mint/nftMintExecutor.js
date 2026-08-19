import { Contract, Interface, Wallet, formatEther, parseEther } from "ethers";
import { loadMintWalletSigningKeys } from "./mintWallets.js";
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
export async function simulateMint(chain, call, from) {
  const provider = getProvider(chain);
  try {
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
          return { address, ok: false, stage: "estimate", reason: err.shortMessage || err.message };
        }

        // Everything above this line is free. The next statement is not.
        if (settings.dryRun) {
          return { address, ok: true, stage: "dry-run", gasLimit, valueWei: call.value, to: call.to };
        }

        const tx = await wallet.sendTransaction({ ...call, gasLimit });
        return { address, ok: true, stage: "sent", txHash: tx.hash, valueWei: call.value };
      } catch (err) {
        return { address, ok: false, stage: "send", reason: err.shortMessage || err.message };
      }
    })
  );

  return { ok: results.some((r) => r.ok), reason: null, results, call };
}

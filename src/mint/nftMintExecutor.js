import { Contract, Interface } from "ethers";
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

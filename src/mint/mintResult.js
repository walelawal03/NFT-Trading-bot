import { Contract, formatEther } from "ethers";
import { getProvider } from "../wallet.js";

// What actually happened after a mint transaction was sent.
//
// A transaction hash is not a result. It can revert, it can mint fewer than
// asked, and "sent" is the last thing the executor knows. This reads the
// receipt and reports what the wallet now owns — the same "never trust the
// tx succeeded just because it didn't revert" discipline the swap executor
// applies on the token side.

const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

const HOLDINGS_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function name() view returns (string)",
];

/**
 * Waits for a mint to land and reports the tokens it produced.
 *
 * Token ids come from the Transfer logs in the receipt rather than from
 * anything we assumed: a mint of 5 that only delivered 3 is a real outcome
 * and must be reported as 3, not as the 5 that were requested.
 */
export async function confirmMint(chain, { txHash, contractAddress, walletAddress, timeoutMs = 60000 }) {
  const provider = getProvider(chain);

  const receipt = await provider.waitForTransaction(txHash, 1, timeoutMs).catch(() => null);
  if (!receipt) {
    return { ok: null, pending: true, txHash, walletAddress, reason: "Still pending — it may land shortly" };
  }
  if (receipt.status !== 1) {
    return { ok: false, pending: false, txHash, walletAddress, reason: "Transaction reverted" };
  }

  // ERC-721 Transfer has 4 topics; the third is the token id. Only transfers
  // TO this wallet count — a mint that also moves a fee token elsewhere
  // should not be reported as ours.
  const toTopic = "0x" + walletAddress.slice(2).toLowerCase().padStart(64, "0");
  const tokenIds = receipt.logs
    .filter(
      (l) =>
        l.topics[0] === TRANSFER_TOPIC &&
        l.topics.length === 4 &&
        l.address.toLowerCase() === contractAddress.toLowerCase() &&
        l.topics[2].toLowerCase() === toTopic
    )
    .map((l) => BigInt(l.topics[3]).toString());

  const gasCostWei = receipt.gasUsed * (receipt.gasPrice ?? 0n);

  const c = new Contract(contractAddress, HOLDINGS_ABI, provider);
  const [balance, name] = await Promise.all([
    c.balanceOf(walletAddress).catch(() => null),
    c.name().catch(() => null),
  ]);

  return {
    ok: true,
    pending: false,
    txHash,
    // Carried through because the wallet that minted is the only one that can
    // list: these are burners from the mint roster, not the configured main
    // wallet, and a sell path that forgets which one signs would offer a
    // listing from an address owning nothing.
    walletAddress,
    tokenIds,
    balance: balance == null ? null : Number(balance),
    name,
    gasCostEth: Number(formatEther(gasCostWei)),
    blockNumber: receipt.blockNumber,
  };
}

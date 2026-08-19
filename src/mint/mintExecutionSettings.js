import fs from "node:fs";
import path from "node:path";
import { getDataDir } from "../dataDir.js";

const settingsPath = () => path.join(getDataDir(), "mintExecutionSettings.json");

// Starts OFF, and stays off until someone turns it on deliberately. Same
// discipline as nftRealTradingSettings: the difference between a bot that
// reads drops and a bot that spends your ETH should never be a default.
//
// maxSpendEthPerRun is the backstop that matters most. Every other number
// here is a preference; this one is what stands between a fat-fingered
// quantity and an empty wallet. It bounds the WHOLE run — quantity x wallets
// x price — not a single transaction, because the failure mode is minting 3
// across 20 wallets, not overpaying once.
const DEFAULTS = {
  enabled: false,
  maxSpendEthPerRun: 0.05,
  // Multiplier on the estimated gas limit. Mints commonly use more gas than a
  // cold estimate suggests (first write to a slot, allowlist checks), and an
  // out-of-gas revert at a launch costs the allocation as well as the gas.
  gasLimitMultiplier: 1.3,
  // Refuse to send anything the simulation says would revert. Off is a
  // deliberate choice for a launch where the phase flips open between
  // simulating and sending; on is right for everything else.
  requireSimulation: true,
};

export function loadMintExecutionSettings() {
  if (!fs.existsSync(settingsPath())) {
    saveMintExecutionSettings(DEFAULTS);
    return { ...DEFAULTS };
  }
  try {
    return { ...DEFAULTS, ...JSON.parse(fs.readFileSync(settingsPath(), "utf8")) };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveMintExecutionSettings(settings) {
  fs.writeFileSync(settingsPath(), JSON.stringify(settings, null, 2));
}

export { DEFAULTS as MINT_EXECUTION_DEFAULTS };

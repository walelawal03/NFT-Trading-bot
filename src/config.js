import "dotenv/config";

function required(name) {
  const val = process.env[name];
  if (!val) throw new Error(`Missing required env var: ${name}`);
  return val;
}

const primaryChatId = required("TELEGRAM_CHAT_ID");
// Extra broadcast destinations (channels, other groups) — comma separated,
// e.g. "@superalphachannel,@anotherchannel". The bot must already be an
// admin with post permission in each. Signals go to all of these plus the
// primary chat.
const extraDestinations = (process.env.TELEGRAM_SIGNAL_CHANNELS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

export const config = {
  telegram: {
    botToken: required("TELEGRAM_BOT_TOKEN"),
    chatId: primaryChatId,
    destinations: [primaryChatId, ...extraDestinations],
    adminUserId: process.env.ADMIN_USER_ID ? String(process.env.ADMIN_USER_ID) : null,
  },
  // Which chains are watched is nftChains.js, not an env var here.
  etherscanApiKey: process.env.ETHERSCAN_API_KEY || null,
  goplusAppKey: process.env.GOPLUS_APP_KEY || null,
  goplusAppSecret: process.env.GOPLUS_APP_SECRET || null,
  openseaApiKey: process.env.OPENSEA_API_KEY || null,
  walletPrivateKey: process.env.WALLET_PRIVATE_KEY || null,
  // Guards the wallet menu — key reveal and key replacement. Named for the
  // token bot's real-funds lock, kept because renaming the env var would
  // silently unlock every existing install on the next boot.
  realTradingPasscode: process.env.REAL_TRADING_PASSCODE || null,
};

export function getRpcUrl(chain) {
  return required(chain.wssEnvVar);
}

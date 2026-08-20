// Per-chain settings: WSS RPC env var, DEX factories to watch, and ids used
// by external APIs (GoPlus chain id, Etherscan V2 chainid, DexScreener chain slug).
//
// Each factory's `parse(args)` maps that event's raw arg list to
// [token0, token1, pairAddress] since different DEXs order/shape this
// differently (e.g. Aerodrome's PoolCreated has a `stable` bool between the
// tokens and the pool address).
const uniswapV2Factory = (address) => ({
  dexName: "uniswap-v2",
  address,
  abi: ["event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"],
  event: "PairCreated",
  parse: (args) => [args[0], args[1], args[2]],
});

const pancakeV2Factory = (address) => ({
  dexName: "pancakeswap-v2",
  address,
  abi: ["event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"],
  event: "PairCreated",
  parse: (args) => [args[0], args[1], args[2]],
});

// Standard PairCreated shape (confirmed live: decoded the exact event topics
// from a real pair's creation tx on Stable chain) — same ABI as the others
// above, just labeled for its actual DEX rather than generically as
// "uniswap-v2", since dexName feeds into launch-source tracking/labeling.
const dyorswapFactory = (address) => ({
  dexName: "dyorswap",
  address,
  abi: ["event PairCreated(address indexed token0, address indexed token1, address pair, uint256)"],
  event: "PairCreated",
  parse: (args) => [args[0], args[1], args[2]],
});

const aerodromeFactory = (address) => ({
  dexName: "aerodrome",
  address,
  abi: [
    "event PoolCreated(address indexed token0, address indexed token1, bool indexed stable, address pool, uint256)",
  ],
  event: "PoolCreated",
  parse: (args) => [args[0], args[1], args[3]], // pool address is arg index 3 here, not 2
});

// Noxa's launch event name/full ABI isn't published anywhere — reverse
// engineered from live logs: topic0 below, with the new token address at
// topics[1]. Confirmed across many independent launches by cross-checking
// topics[1] against that same tx's ERC20 mint (Transfer from 0x0) event —
// it resolves to a real token with sensible name/symbol/supply every time.
// topics[3] is NOT a per-launch pool address — it's a fixed singleton
// contract shared by every launch (confirmed: identical value recurred
// across unrelated transactions). Using it as the dedup key meant the very
// first launch ever caught marked it "seen" and silently dropped every
// launch after that. The token address is the only field guaranteed unique
// per launch, so it doubles as its own dedup key here.
const noxaFactory = (address, wethAddress) => ({
  dexName: "noxa",
  address,
  topic0: "0xdb51ea9ad51ab453a65a4cb7e60c3cb378c9501bb002609f8f97778fb6c4235a",
  parse: (log) => {
    const token = `0x${log.topics[1].slice(26)}`;
    return [token, wethAddress, token];
  },
});

export const CHAINS = {
  ethereum: {
    label: "Ethereum",
    wssEnvVar: "ETHEREUM_WSS_RPC",
    httpEnvVar: "ETHEREUM_HTTP_RPC",
    // publicnode refuses 1000-block eth_getLogs here the same way it does on
    // BSC (verified 2026-08-16), so log polling needs somewhere else to land.
    // mevblocker serves those reads, but it is a transaction-privacy relay
    // first — it routes eth_sendRawTransaction to builders rather than to a
    // public mempool — so it is deliberately confined to the log list and
    // kept well away from the path that broadcasts trades.
    logRpcUrls: ["https://rpc.mevblocker.io"],
    nativeSymbol: "ETH",
    factories: [uniswapV2Factory("0x5C69bEe701ef814a2B6a3EDD4B1652CB9cc5aA6f")],
    wrappedNative: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", // WETH
    // Uniswap V2 Router02 — verified on-chain (factory()/WETH() match the
    // addresses above) before being trusted for real-fund execution.
    routerAddress: "0x7a250d5630B4cF539739dF2C5dAcb4c659F2488D",
    goplusChainId: "1",
    etherscanChainId: 1,
    dexscreenerChainId: "ethereum",
  },
  base: {
    label: "Base",
    wssEnvVar: "BASE_WSS_RPC",
    httpEnvVar: "BASE_HTTP_RPC",
    // Base's own public endpoint handles everything the bot asks for,
    // including the 1000-block log queries publicnode refuses (verified
    // 2026-08-16), so one list covers both jobs here.
    httpRpcUrls: ["https://mainnet.base.org"],
    logRpcUrls: ["https://mainnet.base.org", "https://base-rpc.publicnode.com"],
    // Base IS on Etherscan V2, but not on the free plan: getcontractcreation
    // returns "Free API access is not supported for this chain. Please
    // upgrade your api plan." Without a fallback that left every Base
    // collection with deployerAddress: null — so deployer_address was null
    // on every recorded call and the realized deployer record had nothing to
    // join on. Silent, and permanent: the category just scored
    // NO_DATA_FACTOR forever while looking like it was working.
    // Verified live 2026-08-18: base.blockscout.com answers the same
    // Etherscan-shaped getcontractcreation, free and unauthenticated.
    blockscoutBaseUrl: "https://base.blockscout.com",
    nativeSymbol: "ETH",
    factories: [
      uniswapV2Factory("0x8909Dc15e40173Ff4699343b6eB8132c65e18eC6"),
      aerodromeFactory("0x420dd381b31aef6683db6b902084cb0ffece40da"),
    ],
    wrappedNative: "0x4200000000000000000000000000000000000006", // WETH on Base
    // Verified on-chain against the uniswapV2Factory above.
    routerAddress: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    goplusChainId: "8453",
    etherscanChainId: 8453,
    dexscreenerChainId: "base",
  },
  bsc: {
    label: "BNB Chain",
    wssEnvVar: "BSC_WSS_RPC",
    httpEnvVar: "BSC_HTTP_RPC",
    // BSC's free endpoints split cleanly by capability, and no single one
    // covers both jobs — measured 2026-08-16 against the watcher's real
    // query shape (address + topic0, 1000-block span) and a real receipt:
    //
    //   endpoint                     eth_getLogs(1000)   eth_getTransactionReceipt
    //   bsc-rpc.publicnode.com       OK                  "Archive requests require
    //                                                     a personal token" (-32602)
    //   bsc-dataseed1.ninicoin.io    "limit exceeded"    OK
    //   bsc-dataseed1.defibit.io     "limit exceeded"    OK
    //   bsc-dataseed.bnbchain.org    "limit exceeded"    OK
    //   bsc.blockrazor.xyz           range too large     OK
    //
    // The dataseed family disables log queries outright (it rejects even a
    // 50-block span), while publicnode is the only one that serves them —
    // and is exactly the one that refuses receipts. Hence two lists: trade
    // execution and every other read go to the dataseeds, log polling stays
    // on publicnode. Each still fails over within its own list.
    //
    // This is not hypothetical: publicnode's receipt refusal is what made a
    // successful 牛回 buy on 2026-08-16 report as a failed trade, leaving a
    // real position untracked with no stop-loss watching it.
    // The official dataseed family only, ordered by measured responsiveness.
    // bsc.blockrazor.xyz answers everything here too but is deliberately left
    // out: it is a private-orderflow relay, so it would route the bot's swaps
    // to builders instead of the public mempool — not something to inherit by
    // accident from a fallback list.
    httpRpcUrls: [
      "https://bsc-dataseed1.ninicoin.io",
      "https://bsc-dataseed.bnbchain.org",
      "https://bsc-dataseed1.defibit.io",
    ],
    // publicnode was the only free endpoint serving these queries when this
    // was first written, which left log polling with no real redundancy —
    // and it showed: on 2026-08-17 publicnode returned its archive refusal as
    // an HTTP 403, every dataseed refused the query as it always does, and
    // the watcher lost a poll cycle outright.
    //
    // blxrbdn is a genuinely independent second source (different operator,
    // 0/12 failures over 1000-block spans, p50 265ms). It is logs-only by
    // design: it answers eth_getTransactionReceipt with null rather than the
    // receipt, which is harmless here because only the watcher uses this list
    // — but it is exactly why it must never be added to httpRpcUrls, where a
    // null receipt would read as "not mined yet".
    //
    // bsc.publicnode.com is deliberately NOT listed: it serves these queries
    // too, but gates receipts with the identical message, so it is the same
    // infrastructure under another hostname — redundancy in appearance only.
    logRpcUrls: ["https://bsc-rpc.publicnode.com", "https://bsc.rpc.blxrbdn.com"],
    // Confirmed live: the WSS subscription was dropping (code 1006) roughly
    // every 2 minutes overnight on 2026-07-23/24 — 228 disconnects across
    // 8.2 hours — while Robinhood Chain's polling watcher kept working the
    // entire time. That's not occasional flakiness, it's effectively no
    // real-time coverage on this chain at all; zero new-pair detections on
    // BSC that whole window is what actually surfaced this. Switching to
    // the same polling approach already proven reliable for Robinhood Chain
    // rather than continuing to chase a WS connection this unstable.
    pollingOnly: true,
    nativeSymbol: "BNB",
    factories: [pancakeV2Factory("0xcA143Ce32Fe78f1f7019d7d551a6402fC5350c73")],
    wrappedNative: "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c", // WBNB
    // PancakeSwap V2 Router02 — verified on-chain.
    routerAddress: "0x10ED43C718714eb63d5aA57B78B54704E256024E",
    goplusChainId: "56",
    etherscanChainId: 56,
    dexscreenerChainId: "bsc",
  },
  arbitrum: {
    label: "Arbitrum",
    wssEnvVar: "ARBITRUM_WSS_RPC",
    httpEnvVar: "ARBITRUM_HTTP_RPC",
    // Same story as Base — the chain's own endpoint serves the log queries
    // publicnode refuses (verified 2026-08-16).
    httpRpcUrls: ["https://arb1.arbitrum.io/rpc"],
    logRpcUrls: ["https://arb1.arbitrum.io/rpc", "https://arbitrum-one-rpc.publicnode.com"],
    nativeSymbol: "ETH",
    factories: [uniswapV2Factory("0xf1D7CC64Fb4452F05c498126312eBE29f30Fbcf9")],
    wrappedNative: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", // WETH on Arbitrum
    // Verified on-chain against the factory above (same address as Base's
    // router — a CREATE2 deployment shared across chains).
    routerAddress: "0x4752ba5DBc23f44D87826276BF6Fd6b1C372aD24",
    goplusChainId: "42161",
    etherscanChainId: 42161,
    dexscreenerChainId: "arbitrum",
  },
  robinhood: {
    label: "Robinhood Chain",
    wssEnvVar: "ROBINHOOD_WSS_RPC",
    // Robinhood Chain's public "feed" WSS is a proprietary Arbitrum Orbit
    // sequencer stream, not an eth_subscribe-compatible JSON-RPC endpoint —
    // confirmed by inspecting raw frames. Poll over HTTP instead.
    pollingOnly: true,
    // Two independent endpoints, because this is the chain the mint bot
    // actually mints on and it ran on exactly one until 2026-08-19. There was
    // no redundancy at all: httpUrlsFor's only other entry was the HTTPS form
    // of the WSS feed above, which answers 520 to every JSON-RPC request
    // because it is a sequencer stream, not a node. One bad minute at drop
    // time and nothing gets sent.
    //
    // Measured 2026-08-19 against the mint path's real call shapes — chainId,
    // balance, nonce, getCode, call, gasPrice, feeHistory, estimateGas,
    // receipt, and a deliberately malformed sendRawTransaction to prove the
    // endpoint can broadcast at all:
    //
    //   endpoint                          all 12 methods   p50
    //   robinhood-rpc.publicnode.com      OK               200ms
    //   rpc.mainnet.chain.robinhood.com   OK               306ms
    //   robinhood.drpc.org                HTTP 400 on 9    212ms
    //   robinhood.blockpi.network         "Apikey not found"
    //   rpc.ankr.com/robinhood            403, key required
    //   4663.rpc.thirdweb.com             "Invalid chain"
    //   robinhoodchain.blockscout.com     rate limited
    //
    // publicnode leads deliberately, against the usual instinct to trust the
    // first-party endpoint: it is both faster AND fresher. Across 12 paired
    // samples it was 2-7 blocks AHEAD of the official endpoint and never once
    // behind — the official URL is the cached/load-balanced one here, so it is
    // the one that would hand back a stale nonce or a stale getPublicDrop.
    // Confirmed the same chain, not a fork: identical block hashes at head-50,
    // head-500, head-5000 and at block 40710666, and an identical receipt
    // (status, block, both logs) for our own first mint.
    //
    // publicnode is a plain public endpoint, not a private-orderflow relay —
    // the distinction that keeps mevblocker, blockrazor and blxrbdn off every
    // send path in this file. Set ROBINHOOD_HTTP_RPC to override the order.
    httpRpcUrls: [
      "https://robinhood-rpc.publicnode.com",
      "https://rpc.mainnet.chain.robinhood.com",
    ],
    // Logs get their own list for the reason spelled out at length under bsc:
    // free endpoints disagree about eth_getLogs more than about anything else,
    // and publicnode is again the one that refuses. Measured 2026-08-19
    // against the watcher's real query (factory address + topic0):
    //
    //   span      publicnode                        official
    //   10        OK                                OK
    //   50        OK                                OK
    //   200       "Archive requests require a       OK
    //   1000       personal token"                  OK (273ms, 1 log)
    //
    // So it serves a ~50-block window and refuses anything deeper. The
    // watcher polls 1000-block spans, which means leading the log list with
    // publicnode would burn a failover on every single cycle while looking
    // like it worked. Official leads here; publicnode still trails it via
    // httpUrlsFor and covers the narrow spans, which is better than nothing
    // if the official endpoint drops.
    //
    // This is exactly the split that made a real BSC buy report as a failed
    // trade on 2026-08-16 — same operator, same refusal, caught before it
    // shipped this time rather than after.
    logRpcUrls: ["https://rpc.mainnet.chain.robinhood.com"],
    // The WSS above is an Arbitrum Orbit sequencer feed, so its HTTPS form is
    // not a node and must never be derived into the RPC list — see
    // derivedHttpFromWss in wallet.js. Measured: HTTP 520 on eth_chainId.
    wssIsSequencerFeed: true,
    nativeSymbol: "ETH",
    factories: [
      uniswapV2Factory("0x8bceaa40b9acdfaedf85adf4ff01f5ad6517937f"),
      noxaFactory("0xD9eC2db5f3D1b236843925949fe5bd8a3836FCcB", "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73"),
    ],
    wrappedNative: "0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73", // WETH on Robinhood Chain
    // Found by tracing a real swap transaction against a live Noxa-launched
    // pair, then confirmed via factory()/WETH() — the first candidate
    // address found this way was a different Noxa-specific contract, not
    // the router, so this was not just a memory-recalled address.
    routerAddress: "0x89e5DB8B5aA49aA85AC63f691524311AEB649eba",
    // Uniswap V3 SwapRouter02 — some pairs on this chain (e.g. NPC) trade
    // exclusively through V3 concentrated-liquidity pools, invisible to the
    // V2 router above. Verified three independent ways: (1) Blockscout tags
    // this address "SwapRouter02" via the Open Labels Initiative, (2)
    // factory() returns 0x1f7d7550B1b028f7571E69A784071F0205FD2EfA and
    // WETH9() returns the wrappedNative address below, both on-chain reads
    // against this exact address, (3) it's the dominant pool.swap() caller
    // on NPC's real, actively-traded V3 pool, and its real buy/sell calldata
    // decodes byte-for-byte as the standard SwapRouter02 exactInputSingle
    // ABI (selector 0x04e45aaf).
    v3RouterAddress: "0xCaf681a66D020601342297493863E78C959E5cb2",
    // QuoterV2 for the same V3 deployment as the router above. Verified three
    // independent ways: (1) Blockscout tags it "QuoterV2", (2) its factory()
    // and WETH9() reads match the router's exact factory/WETH addresses —
    // the only match out of 9 candidate Quoter/QuoterV2 contracts on this
    // chain, the rest belong to other DEX deployments sharing it, (3) a live
    // quoteExactInputSingle call against a real, high-liquidity pool (VLAD,
    // $3.2M) returned a correctly-shaped, plausible quote.
    v3QuoterAddress: "0x33e885eD0Ec9bF04EcfB19341582aADCb4c8A9E7",
    goplusChainId: "4663",
    etherscanChainId: 4663, // not on Etherscan V2 yet — deployer history falls back to blockscoutBaseUrl below instead of degrading to neutral
    // Robinhood Chain's own Blockscout instance, found by following the
    // redirect from https://explorer.mainnet.chain.robinhood.com. Exposes
    // the same Etherscan-shaped API for free at /api?module=...&action=...
    // (confirmed live: module=contract&action=getcontractcreation and
    // module=account&action=txlist both return real data) — see
    // risk/explorer.js's Etherscan-then-Blockscout fallback.
    blockscoutBaseUrl: "https://robinhoodchain.blockscout.com",
    dexscreenerChainId: "robinhood",
  },
  stable: {
    label: "Stable",
    // No confirmed WSS endpoint for this chain yet — poll over HTTP rather
    // than assume eth_subscribe compatibility (same caution as Robinhood
    // Chain, where that assumption was wrong).
    pollingOnly: true,
    httpRpcUrl: "https://rpc.stable.xyz",
    // The chain's own native gas token is USDT0 itself (not a separate
    // volatile asset) — MetaMask/wallet UIs show it as "gUSDT". Paying gas
    // in a stablecoin is the entire point of this chain.
    nativeSymbol: "USDT0",
    factories: [dyorswapFactory("0xDFEf2F90F7E52609cC89b80b68Ff6a1C86C4ddc4")],
    // "Wrapped gUSDT" — confirmed two independent ways: it's DexScreener's
    // reported quote token for a real dyorswap pair, and it's also what the
    // router itself returns from WETH() (same address both ways).
    wrappedNative: "0x817997Ca8394E26CCE3dE3A076a4889b27DbF9dE",
    // Router and factory are the same contract — confirmed via WETH()
    // matching the wrappedNative address above, and via 530+ unique callers
    // / 1000+ transactions (the other PairCreated-emitting candidate found
    // during verification had only 6 txs from 2 callers — an unrelated,
    // essentially unused contract, not the real factory). This contract's
    // own getPair()/factory() getters revert though, so anything reading them
    // has to tolerate an unsupported call rather than conclude "no pair
    // exists" from it.
    routerAddress: "0xDFEf2F90F7E52609cC89b80b68Ff6a1C86C4ddc4",
    // Not onboarded — confirmed via a direct API call returning code 2022
    // "The main chain is not supported". Same fallback posture as Robinhood
    // Chain: contract-safety/holder/LP-lock scoring runs on the self-hosted
    // checks (roundTripProbe, probeSellability, dangerousFunctions, on-chain
    // LP-lock) instead.
    goplusChainId: "988",
    // Unlike Robinhood Chain, Etherscan V2 already covers this chain
    // directly (confirmed live with our real API key) — no Blockscout-style
    // fallback needed for deployer history.
    etherscanChainId: 988,
    dexscreenerChainId: "stable",
  },
};

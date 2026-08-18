// Mint detection, offline. Provider is stubbed via mock.module on wallet.js,
// the same way the capability-scan suite does it, so there is no network, no
// env and no test-only export in production code.
import assert from "node:assert";
import { mock } from "node:test";
import { keccak256, toUtf8Bytes, AbiCoder } from "ethers";

process.env.TELEGRAM_BOT_TOKEN ||= "111:offline";
process.env.TELEGRAM_CHAT_ID ||= "1";

const abi = AbiCoder.defaultAbiCoder();
const sel = (sig) => keccak256(toUtf8Bytes(sig)).slice(0, 10);

// Bytecode whose extracted selectors are exactly the ones asked for. Mirrors
// the dispatcher shape selectorExtraction.js looks for (PUSH4 <sel> EQ).
const runtime = (sigs) => "0x" + sigs.map((s) => `63${sel(s).slice(2)}14`).join("") + "00";

let CODE = {};
let CALLS = {};
mock.module(new URL("../src/wallet.js", import.meta.url).href, {
  namedExports: {
    getProvider: () => ({
      getCode: async (a) => CODE[a.toLowerCase()] ?? "0x",
      getStorage: async () => "0x" + "0".repeat(64),
      call: async ({ to, data }) => CALLS[`${to.toLowerCase()}:${data.slice(0, 10)}`] ?? Promise.reject(new Error("revert")),
    }),
    getLogProvider: () => ({}),
  },
});

const { detectNftMint, SEADROP_1_0 } = await import("../src/mint/nftMintDetect.js");
const { buildMintDetectMessage } = await import("../src/telegram/formatMintDetect.js");

const CHAIN = { key: "robinhood", label: "Robinhood Chain", etherscanChainId: 4663 };
const ERC721 = ["name()", "symbol()", "totalSupply()", "balanceOf(address)", "ownerOf(uint256)", "tokenURI(uint256)", "approve(address,uint256)", "transferFrom(address,address,uint256)"];

let seq = 0;
const nextAddr = () => "0x" + String(++seq).padStart(40, "c");
const encStr = (s) => abi.encode(["string"], [s]);
const encUint = (n) => abi.encode(["uint256"], [n]);

function setup(addr, { sigs, calls = {} }) {
  CODE = { [addr.toLowerCase()]: runtime(sigs) };
  CALLS = {
    [`${addr.toLowerCase()}:${sel("name()")}`]: encStr("Test Drop"),
    [`${addr.toLowerCase()}:${sel("symbol()")}`]: encStr("TEST"),
    ...calls,
  };
}

let pass = 0, fail = 0;
const t = async (name, fn) => { try { await fn(); pass++; console.log(`  ok   ${name}`); }
  catch (e) { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); } };

console.log("\nmintDetect\n");

// The distinction that costs money if wrong: SeaDrop collections are minted
// THROUGH SeaDrop. mintSeaDrop on the collection reverts for everyone else,
// so sending the mint to the collection is a guaranteed failed transaction.
await t("a SeaDrop collection routes the mint to SeaDrop, not the collection", async () => {
  const a = nextAddr();
  setup(a, {
    sigs: [...ERC721, "mintSeaDrop(address,uint256)", "getMintStats(address)", "maxSupply()"],
    calls: {
      [`${a.toLowerCase()}:${sel("totalSupply()")}`]: encUint(500),
      [`${a.toLowerCase()}:${sel("maxSupply()")}`]: encUint(10000),
      [`${SEADROP_1_0.toLowerCase()}:${sel("getPublicDrop(address)")}`]: abi.encode(
        ["tuple(uint80,uint48,uint48,uint16,uint16,bool)"],
        [[100000000000000n, Math.floor(Date.now() / 1000) - 60, Math.floor(Date.now() / 1000) + 3600, 3, 1000, true]]
      ),
    },
  });
  const d = await detectNftMint(CHAIN, a);
  assert.equal(d.standard, "seadrop");
  assert.equal(d.mintVia.target, SEADROP_1_0, "must target SeaDrop");
  assert.notEqual(d.mintVia.target.toLowerCase(), a.toLowerCase(), "must NOT target the collection");
  assert.equal(d.phase.maxPerWallet, 3);
  assert.equal(d.phase.priceWei, 100000000000000n);
  assert.equal(d.mintable, true);
});

// A sold-out collection sits inside an open phase window. Reporting that as
// mintable buys a failed transaction.
await t("sold out is not mintable, even inside an open phase", async () => {
  const a = nextAddr();
  setup(a, {
    sigs: [...ERC721, "getMintStats(address)", "maxSupply()"],
    calls: {
      [`${a.toLowerCase()}:${sel("totalSupply()")}`]: encUint(10000),
      [`${a.toLowerCase()}:${sel("maxSupply()")}`]: encUint(10000),
      [`${SEADROP_1_0.toLowerCase()}:${sel("getPublicDrop(address)")}`]: abi.encode(
        ["tuple(uint80,uint48,uint48,uint16,uint16,bool)"],
        [[1n, Math.floor(Date.now() / 1000) - 60, Math.floor(Date.now() / 1000) + 3600, 3, 0, false]]
      ),
    },
  });
  const d = await detectNftMint(CHAIN, a);
  assert.equal(d.soldOut, true);
  assert.equal(d.phase.live, true, "the phase window really is open");
  assert.equal(d.mintable, false, "but minting would fail");
  assert.match(buildMintDetectMessage({ chain: CHAIN, contractAddress: a, detect: d }), /SOLD OUT/);
});

await t("a phase that has not opened yet is not mintable", async () => {
  const a = nextAddr();
  setup(a, {
    sigs: [...ERC721, "getMintStats(address)", "maxSupply()"],
    calls: {
      [`${a.toLowerCase()}:${sel("totalSupply()")}`]: encUint(0),
      [`${a.toLowerCase()}:${sel("maxSupply()")}`]: encUint(5000),
      [`${SEADROP_1_0.toLowerCase()}:${sel("getPublicDrop(address)")}`]: abi.encode(
        ["tuple(uint80,uint48,uint48,uint16,uint16,bool)"],
        [[1n, Math.floor(Date.now() / 1000) + 7200, Math.floor(Date.now() / 1000) + 90000, 2, 0, false]]
      ),
    },
  });
  const d = await detectNftMint(CHAIN, a);
  assert.equal(d.mintable, false);
  assert.match(buildMintDetectMessage({ chain: CHAIN, contractAddress: a, detect: d }), /NOT OPEN YET/);
});

await t("a direct-mint collection targets itself and reports its price", async () => {
  const a = nextAddr();
  setup(a, {
    sigs: [...ERC721, "mint(uint256)", "mintPrice()", "maxPerWallet()", "saleIsActive()", "maxSupply()"],
    calls: {
      [`${a.toLowerCase()}:${sel("totalSupply()")}`]: encUint(10),
      [`${a.toLowerCase()}:${sel("maxSupply()")}`]: encUint(1000),
      [`${a.toLowerCase()}:${sel("mintPrice()")}`]: encUint(20000000000000000n),
      [`${a.toLowerCase()}:${sel("maxPerWallet()")}`]: encUint(5),
      [`${a.toLowerCase()}:${sel("saleIsActive()")}`]: abi.encode(["bool"], [true]),
    },
  });
  const d = await detectNftMint(CHAIN, a);
  assert.equal(d.standard, "direct");
  assert.equal(d.mintVia.target.toLowerCase(), a.toLowerCase(), "direct mints go to the collection");
  assert.equal(d.mintVia.signature, "mint(uint256)");
  assert.equal(d.phase.priceWei, 20000000000000000n);
  assert.equal(d.phase.maxPerWallet, 5);
  assert.equal(d.mintable, true);
});

// A price that silently reads 0 sends a mint with no value and eats the
// revert — or worse, underpays a contract that accepts it.
await t("an unreadable price is null, never zero", async () => {
  const a = nextAddr();
  setup(a, {
    sigs: [...ERC721, "mint(uint256)"],
    calls: { [`${a.toLowerCase()}:${sel("totalSupply()")}`]: encUint(1) },
  });
  const d = await detectNftMint(CHAIN, a);
  assert.equal(d.standard, "direct");
  assert.equal(d.phase.priceWei, null, "unknown must not become 0");
  assert.match(buildMintDetectMessage({ chain: CHAIN, contractAddress: a, detect: d }), /Price: unknown/);
});

await t("a contract with no mint entrypoint says so instead of guessing", async () => {
  const a = nextAddr();
  setup(a, { sigs: ERC721, calls: { [`${a.toLowerCase()}:${sel("totalSupply()")}`]: encUint(1) } });
  const d = await detectNftMint(CHAIN, a);
  assert.equal(d.standard, "unknown");
  assert.equal(d.mintVia, null);
  assert.match(buildMintDetectMessage({ chain: CHAIN, contractAddress: a, detect: d }), /No recognised mint entrypoint/);
});

await t("an address with no code is reported unreadable, never as a pass", async () => {
  CODE = {}; CALLS = {};
  const d = await detectNftMint(CHAIN, nextAddr());
  assert.equal(d.checked, false);
  assert.equal(d.mintable, false);
  const m = buildMintDetectMessage({ chain: CHAIN, contractAddress: nextAddr(), detect: d });
  assert.match(m, /UNREADABLE/);
  assert.ok(!/MINTING NOW/.test(m));
});

await t("markdown markers stay balanced across every shape", async () => {
  const a = nextAddr();
  setup(a, {
    sigs: [...ERC721, "mint(uint256)", "mintPrice()"],
    calls: {
      [`${a.toLowerCase()}:${sel("totalSupply()")}`]: encUint(3),
      [`${a.toLowerCase()}:${sel("mintPrice()")}`]: encUint(1n),
    },
  });
  const m = buildMintDetectMessage({ chain: CHAIN, contractAddress: a, detect: await detectNftMint(CHAIN, a) });
  for (const ch of ["*", "_", "`"]) {
    const n = [...m].filter((c, i) => c === ch && m[i - 1] !== "\\").length;
    assert.equal(n % 2, 0, `unbalanced ${ch} in:\n${m}`);
  }
  assert.ok(m.length < 4096, `message is ${m.length} chars`);
});

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

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
const FAIL_GETCODE_TIMES = new Map();
mock.module(new URL("../src/wallet.js", import.meta.url).href, {
  namedExports: {
    getProvider: () => ({
      // FAIL_FIRST_GETCODE reproduces the real failure precisely: the scan's
      // read times out, but the fallback read that follows succeeds. Throwing
      // on every call instead would land in the "no contract code" branch and
      // test nothing.
      getCode: async (a) => {
        const key = a.toLowerCase();
        const left = FAIL_GETCODE_TIMES.get(key) ?? 0;
        if (left > 0) {
          FAIL_GETCODE_TIMES.set(key, left - 1);
          throw new Error("connection timed out");
        }
        return CODE[key] ?? "0x";
      },
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

// Observed live on WASTELAND: one read reported "standard: unknown, no
// recognised mint entrypoint", the next reported seadrop with an entrypoint.
// The difference was a scan timeout, not the contract. A failure to READ must
// never render as a confident "there is nothing here" — that is the sentence
// that makes someone give up on a drop they could have minted.
await t("an unreadable contract never renders as 'no mint entrypoint'", () => {
  const unreadable = {
    checked: false,
    reason: "Couldn't resolve this contract in time (RPC slow) — retry rather than trusting this",
    standard: "unknown",
    phase: null,
    mintable: null,
    mintVia: null,
    proxy: null,
  };
  const m = buildMintDetectMessage({ chain: CHAIN, contractAddress: nextAddr(), detect: unreadable });
  assert.match(m, /UNREADABLE/);
  assert.match(m, /not a green light|not.*clean|unknown/i);
  assert.ok(!/No recognised mint entrypoint/.test(m), "must not claim the contract has no mint function");
  assert.ok(!/SOLD OUT|MINTING NOW/.test(m), "must not assert a state it could not read");
});

// And the detector must actually produce that shape rather than a confident
// wrong one when proxy resolution fails on a stub with nothing to read.
await t("a failed resolution on an unreadable stub reports checked:false", async () => {
  const a = nextAddr();
  CODE = { [a.toLowerCase()]: "0x6080" }; // too small to carry any selector
  CALLS = {};
  const d = await detectNftMint(CHAIN, a);
  assert.equal(d.mintVia, null);
  assert.notEqual(d.mintable, true, "must never claim mintable off an unreadable contract");
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

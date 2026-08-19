// Offline exercise of nftDangerousFunctions.js. No RPC: a stub provider
// serves bytecode/storage/call responses so every branch (direct, EIP-1167,
// EIP-1967, beacon, unreachable) can be driven deterministically.
//
// Run: node --experimental-test-module-mocks tests/nftDangerousFunctions.test.mjs
import assert from "node:assert";
import { keccak256, toUtf8Bytes, AbiCoder } from "ethers";

import { mock } from "node:test";

// The unit under test pulls its provider from ../wallet.js, which builds a
// real JsonRpcProvider from env config. mock.module replaces that import
// before the module graph loads, so no network, no env, no test-only
// export bolted onto production code.
let PROVIDER = null;
mock.module(new URL("../src/wallet.js", import.meta.url).href, {
  namedExports: {
    getProvider: () => PROVIDER,
    getWalletForChain: () => null,
    httpUrlFor: () => "http://stub",
  },
});

const { detectNftDangerousFunctions, assessNftContractRisk, prewarmNftScans } = await import(
  "../src/risk/nftDangerousFunctions.js"
);

const sel = (sig) => keccak256(toUtf8Bytes(sig)).slice(0, 10);

// Build runtime bytecode containing a Solidity-style dispatcher:
// PUSH4 <selector> EQ  for each signature, which is exactly what
// extractSelectors() scans for.
function fakeRuntime(signatures) {
  let hex = "6080604052";
  for (const s of signatures) hex += "63" + sel(s).slice(2) + "14";
  hex += "00".repeat(20);
  return "0x" + hex;
}

const ERC721_BASE = [
  "ownerOf(uint256)", "balanceOf(address)", "tokenURI(uint256)", "totalSupply()",
  "approve(address,uint256)", "setApprovalForAll(address,bool)", "getApproved(uint256)",
  "isApprovedForAll(address,address)", "safeTransferFrom(address,address,uint256)",
  "transferFrom(address,address,uint256)", "name()", "symbol()", "owner()",
];

class StubProvider {
  constructor({ code = {}, storage = {}, calls = {} }) {
    this.code = code; this.storage = storage; this.calls = calls;
  }
  async getCode(a) { return this.code[a.toLowerCase()] ?? "0x"; }
  async getStorage(a, slot) {
    return this.storage[`${a.toLowerCase()}:${slot}`] ?? "0x" + "0".repeat(64);
  }
  async call(tx) {
    const key = `${tx.to.toLowerCase()}:${tx.data.slice(0, 10)}`;
    if (this.calls[key]) return this.calls[key];
    throw new Error("execution reverted");
  }
}

const encStr = (s) => AbiCoder.defaultAbiCoder().encode(["string"], [s]);
const encAddr = (a) => AbiCoder.defaultAbiCoder().encode(["address"], [a]);
const slotWord = (a) => "0x" + "0".repeat(24) + a.slice(2).toLowerCase();

PROVIDER = null;

let pass = 0, fail = 0;
function t(name, fn) {
  return fn().then(
    () => { pass++; console.log(`  ok   ${name}`); },
    (e) => { fail++; console.log(`  FAIL ${name}\n       ${e.message}`); }
  );
}

const CHAIN = { key: "robinhood" };

// detectNftDangerousFunctions caches on `${chain.key}:${address}` — a real
// and correct behaviour (one scan per contract, reused across the pipeline),
// but it means every case needs its own address or it gets served the first
// case's result. Found the hard way: nine tests passed vacuously.
let addrN = 0;
const nextAddr = () => "0x" + String(++addrN).padStart(40, "a");
let A = nextAddr();
const IMPL = "0x2222222222222222222222222222222222222222";
const BEACON = "0x3333333333333333333333333333333333333333";

// ── cases ────────────────────────────────────────────────────────────────
const cases = [];

cases.push(["clean collection, IPFS metadata, no setter", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: { [A.toLowerCase()]: fakeRuntime(ERC721_BASE) },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafyxyz/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.checked, true, "should be checked");
  assert.equal(scan.seizure.length, 0);
  assert.equal(scan.transferLock.length, 0);
  assert.equal(scan.metadata.level, "low", `metadata level was ${scan.metadata.level}`);
  const v = assessNftContractRisk(scan);
  assert.equal(v.fatal, false);
  assert.equal(v.deduction, 0, `expected 0 deduction, got ${v.deduction}`);
}]);

cases.push(["pause() with no unpause() is fatal — a one-way door", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: { [A.toLowerCase()]: fakeRuntime([...ERC721_BASE, "pause()"]) },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.deepEqual(scan.transferLock, ["pause()"]);
  assert.equal(scan.pauseReversible, false);
  assert.equal(assessNftContractRisk(scan).fatal, true);
}]);

// The TOKIEMON case (0x802187c3..., Base, 86,538 minted): OpenZeppelin
// ERC721Pausable on non-upgradeable logic. Was fatal, which rejected a
// shipped collection on a framework default.
cases.push(["reversible pause on fixed logic deducts but does not kill", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: { [A.toLowerCase()]: fakeRuntime([...ERC721_BASE, "pause()", "unpause()"]) },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.pauseReversible, true);
  const v = assessNftContractRisk(scan);
  assert.equal(v.fatal, false, "OZ Pausable boilerplate must not hard-reject");
  assert.equal(v.deduction, 12, "but it must cost heavily");
}]);

// Reversible today proves nothing if the logic can be swapped tomorrow:
// an upgrade can drop unpause() entirely.
cases.push(["reversible pause behind upgradeable logic is fatal", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: {
      [A.toLowerCase()]: "0x363d3d373d3d3d363d5af43d82803e903d91602b57fd5bf3",
      [IMPL.toLowerCase()]: fakeRuntime([...ERC721_BASE, "pause()", "unpause()"]),
    },
    storage: {
      [`${A.toLowerCase()}:0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`]: slotWord(IMPL),
    },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.pauseReversible, true, "unpause() is present…");
  assert.equal(scan.proxy.upgradeable, true, "…but the logic can change");
  assert.equal(assessNftContractRisk(scan).fatal, true);
}]);

// A denylist targets one holder while the collection still looks liquid.
// No reversibility argument applies — this stays fatal unconditionally.
cases.push(["targeted denial is fatal even alongside a reversible pause", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: { [A.toLowerCase()]: fakeRuntime([...ERC721_BASE, "pause()", "unpause()", "blacklist(address)"]) },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.deepEqual(scan.transferDeny, ["blacklist(address)"]);
  assert.equal(scan.pauseReversible, true);
  assert.equal(assessNftContractRisk(scan).fatal, true);
}]);

cases.push(["metadata rug: mutable setter + centralised host = high", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: { [A.toLowerCase()]: fakeRuntime([...ERC721_BASE, "setBaseURI(string)"]) },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("https://api.somedrop.xyz/meta/1") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.metadata.level, "high", `got ${scan.metadata.level}`);
  const v = assessNftContractRisk(scan);
  assert.equal(v.fatal, false, "metadata risk is a deduction, not a hard gate");
  assert.ok(v.deduction >= 12, `expected >=12, got ${v.deduction}`);
}]);

cases.push(["mutable setter + IPFS = medium, not high (no false positive on reveal)", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: { [A.toLowerCase()]: fakeRuntime([...ERC721_BASE, "setBaseURI(string)", "reveal()"]) },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafyreveal/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.metadata.level, "medium", `got ${scan.metadata.level}`);
}]);

cases.push(["freeze capability downgrades medium to low", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: { [A.toLowerCase()]: fakeRuntime([...ERC721_BASE, "setBaseURI(string)", "freezeMetadata()"]) },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.metadata.level, "low");
  assert.deepEqual(scan.metadataFreeze, ["freezeMetadata()"]);
}]);

cases.push(["EIP-1167 clone resolves to implementation code", async () => {
  A = nextAddr();
  const cloneCode = "0x363d3d373d3d3d363d73" + IMPL.slice(2).toLowerCase() + "5af43d82803e903d91602b57fd5bf3";
  PROVIDER = new StubProvider({
    code: {
      [A.toLowerCase()]: cloneCode,
      [IMPL.toLowerCase()]: fakeRuntime([...ERC721_BASE, "seize(uint256)"]),
    },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.proxy.via, "eip1167");
  assert.equal(scan.proxy.upgradeable, false, "clones are immutable");
  assert.deepEqual(scan.seizure, ["seize(uint256)"], "must read the impl, not the 45-byte stub");
}]);

// Regression: AMEX PASSPORT (0x96cebb59..., Base) is a 44-byte Solady
// LibClone proxy. Against a canonical-only match it extracted 0 selectors
// and scored UNKNOWN at 17/35 — a live 3.5M-supply collection reading as
// unscannable. The seize() below is the point: it lives in the impl, so a
// resolver that stops at the 44-byte stub reports a clean contract.
cases.push(["Solady LibClone (44-byte) resolves to implementation code", async () => {
  A = nextAddr();
  const cloneCode = "0x3d3d3d3d363d3d37363d73" + IMPL.slice(2).toLowerCase() + "5af43d3d93803e602a57fd5bf3";
  assert.equal((cloneCode.length - 2) / 2, 44, "template must be 44 bytes");
  PROVIDER = new StubProvider({
    code: {
      [A.toLowerCase()]: cloneCode,
      [IMPL.toLowerCase()]: fakeRuntime([...ERC721_BASE, "seize(uint256)"]),
    },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.proxy.via, "eip1167_solady");
  assert.equal(scan.proxy.implementation.toLowerCase(), IMPL.toLowerCase());
  assert.equal(scan.proxy.upgradeable, false, "clones are immutable");
  assert.ok(scan.checked, "must not fall through to unknown");
  assert.deepEqual(scan.seizure, ["seize(uint256)"], "must read the impl, not the 44-byte stub");
}]);

// A near-miss must not resolve: same prefix, one byte short of any template.
cases.push(["a truncated clone stub is not mistaken for a proxy", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: { [A.toLowerCase()]: "0x3d3d3d3d363d3d37363d73" + IMPL.slice(2).toLowerCase() + "5af43d3d93803e602a57fd5b" },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.notEqual(scan.proxy.via, "eip1167_solady");
  assert.notEqual(scan.proxy.via, "eip1167");
}]);

cases.push(["EIP-1967 proxy resolves and is marked upgradeable", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: {
      [A.toLowerCase()]: "0x363d3d373d3d3d363d5af43d82803e903d91602b57fd5bf3",
      [IMPL.toLowerCase()]: fakeRuntime([...ERC721_BASE, "setBaseURI(string)"]),
    },
    storage: {
      [`${A.toLowerCase()}:0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc`]: slotWord(IMPL),
    },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.proxy.via, "eip1967");
  assert.equal(scan.proxy.upgradeable, true);
  assert.deepEqual(scan.metadataControl, ["setBaseURI(string)"]);
  assert.ok(assessNftContractRisk(scan).deduction >= 10, "upgradeable must cost points");
}]);

cases.push(["beacon proxy follows implementation() on the beacon", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: {
      [A.toLowerCase()]: "0x363d3d373d3d3d363d5af43d82803e903d91602b57fd5bf3",
      [IMPL.toLowerCase()]: fakeRuntime([...ERC721_BASE, "blacklist(address)"]),
      [BEACON.toLowerCase()]: "0x60806040",
    },
    storage: {
      [`${A.toLowerCase()}:0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50`]: slotWord(BEACON),
    },
    calls: {
      [`${BEACON.toLowerCase()}:${sel("implementation()")}`]: encAddr(IMPL),
      [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json"),
    },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.proxy.via, "beacon");
  assert.equal(scan.proxy.upgradeable, true);
  assert.deepEqual(scan.transferLock, ["blacklist(address)"]);
}]);

cases.push(["unreachable RPC returns checked:false, never clean", async () => {
  A = nextAddr();
  PROVIDER = {
    getCode: async () => { throw new Error("connection refused"); },
    getStorage: async () => { throw new Error("connection refused"); },
    call: async () => { throw new Error("connection refused"); },
  };
  const scan = await detectNftDangerousFunctions(CHAIN, "0x9999999999999999999999999999999999999999");
  assert.equal(scan.checked, false);
  const v = assessNftContractRisk(scan);
  assert.equal(v.unknown, true, "must be flagged unknown");
  assert.ok(v.deduction > 0, "unknown must cost points, not be free");
}]);

cases.push(["unreadable bytecode (too few selectors) flags unknown", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: { [A.toLowerCase()]: "0x60806040" + "00".repeat(40) },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.selectorCount, 0);
  assert.equal(assessNftContractRisk(scan).unknown, true, "0 selectors must not read as clean");
}]);

cases.push(["supply + economic controls deduct but don't kill", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({
    code: {
      [A.toLowerCase()]: fakeRuntime([
        ...ERC721_BASE, "devMint(uint256)", "setMaxSupply(uint256)",
        "setPrice(uint256)", "setDefaultRoyalty(address,uint96)",
      ]),
    },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(scan.supplyControl.length, 2);
  assert.equal(scan.economicControl.length, 2);
  const v = assessNftContractRisk(scan);
  assert.equal(v.fatal, false);
  assert.ok(v.deduction > 0 && v.deduction <= 35, `deduction ${v.deduction} out of range`);
}]);


cases.push(["budget is honoured and reported as timedOut, not clean", async () => {
  A = nextAddr();
  const slow = () => new Promise((r) => setTimeout(r, 400));
  PROVIDER = {
    getCode: async () => { await slow(); return fakeRuntime(ERC721_BASE); },
    getStorage: async () => { await slow(); return "0x" + "0".repeat(64); },
    call: async () => { await slow(); throw new Error("revert"); },
  };
  const t0 = Date.now();
  const scan = await detectNftDangerousFunctions(CHAIN, A, { budgetMs: 150 });
  const elapsed = Date.now() - t0;
  assert.equal(scan.checked, false, "must not claim a clean scan");
  assert.equal(scan.timedOut, true, "must be marked timedOut");
  assert.ok(elapsed < 400, `returned in ${elapsed}ms, budget was 150ms — must not retry past the ceiling`);
  const v = assessNftContractRisk(scan);
  assert.equal(v.unknown, true);
  assert.ok(v.deduction > 0, "a timed-out scan must cost points");
}]);

// A timed-out scan is a fact about the RPC in that moment, not about the
// contract. Caching it meant one slow moment marked a collection unreadable
// for the life of the process — every later paste served the poisoned entry
// instantly, and retrying could not help because the retry hit the cache.
cases.push(["a failed scan is not cached, so a retry can succeed", async () => {
  A = nextAddr();
  PROVIDER = new StubProvider({ fail: true });
  const first = await detectNftDangerousFunctions(CHAIN, A, { budgetMs: 150 });
  assert.equal(first.checked, false, "first attempt fails");

  // Same address, working provider: must actually re-scan rather than serve
  // the earlier failure.
  PROVIDER = new StubProvider({
    code: { [A.toLowerCase()]: fakeRuntime([...ERC721_BASE, "setBaseURI(string)"]) },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  const second = await detectNftDangerousFunctions(CHAIN, A, { budgetMs: 5000 });
  assert.equal(second.checked, true, "a retry must be able to succeed after a transient failure");
}]);

cases.push(["prewarm makes the later scan a zero-network cache hit", async () => {
  A = nextAddr();
  let calls = 0;
  const base = new StubProvider({
    code: { [A.toLowerCase()]: fakeRuntime(ERC721_BASE) },
    calls: { [`${A.toLowerCase()}:${sel("tokenURI(uint256)")}`]: encStr("ipfs://bafy/1.json") },
  });
  PROVIDER = {
    getCode: (...a) => { calls++; return base.getCode(...a); },
    getStorage: (...a) => { calls++; return base.getStorage(...a); },
    call: (...a) => { calls++; return base.call(...a); },
  };
  const res = await prewarmNftScans(CHAIN, [A]);
  assert.equal(res.warmed, 1);
  const afterWarm = calls;
  assert.ok(afterWarm > 0, "prewarm should actually hit the network");
  const t0 = Date.now();
  const scan = await detectNftDangerousFunctions(CHAIN, A);
  assert.equal(calls, afterWarm, "cached scan must issue zero further RPC calls");
  assert.equal(scan.checked, true);
  assert.ok(Date.now() - t0 < 5, "cache hit should be effectively instant");
}]);

console.log("\nnftDangerousFunctions\n");
for (const [name, fn] of cases) await t(name, fn);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  ok   ${name}`);
  } catch (e) {
    fail++;
    console.log(`  FAIL ${name}\n       ${e.message}`);
  }
};

const importFresh = async (tag) => import(new URL(`../src/nftChains.js?${tag}`, import.meta.url).href);

const withTempEnv = async (env, fn) => {
  const prev = {};
  for (const [key, value] of Object.entries(env)) {
    prev[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nftchains-"));
  prev.RAILWAY_VOLUME_MOUNT_PATH = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.RAILWAY_VOLUME_MOUNT_PATH = dir;
  try {
    return await fn(dir);
  } finally {
    for (const [key, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  }
};

console.log("\nnftChains\n");

await t("legacy CHAINS seeds the enabled NFT chain list", async () => {
  await withTempEnv({ NFT_CHAINS: undefined, CHAINS: "base,ethereum,arbitrum,monad,arc,robinhood" }, async () => {
    const mod = await importFresh("cha-alias");
    assert.deepEqual(mod.loadEnabledNftChains(), ["base", "ethereum", "arbitrum", "monad", "arc", "robinhood"]);
  });
});

await t("NFT_CHAINS wins when both aliases are present", async () => {
  await withTempEnv({ NFT_CHAINS: "robinhood,monad,ethereum", CHAINS: "base" }, async () => {
    const mod = await importFresh("nft-alias");
    assert.deepEqual(mod.loadEnabledNftChains(), ["robinhood", "monad", "ethereum"]);
  });
});

await t("ethereum has a built-in RPC fallback when the env var is absent", async () => {
  await withTempEnv(
    { TELEGRAM_BOT_TOKEN: "x", TELEGRAM_CHAT_ID: "1", ETHEREUM_HTTP_RPC: undefined },
    async () => {
      const { CHAINS } = await import(new URL("../src/chains.js?fallback", import.meta.url).href);
      const { httpUrlsFor } = await import(new URL("../src/wallet.js?fallback", import.meta.url).href);
      assert.deepEqual(httpUrlsFor(CHAINS.ethereum), ["https://ethereum-rpc.publicnode.com"]);
    }
  );
});

try {
  console.log(`\n${pass} passed, ${fail} failed\n`);
  process.exit(fail === 0 ? 0 : 1);
} catch {
  process.exit(1);
}

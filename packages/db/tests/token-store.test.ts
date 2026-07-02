import { env } from "cloudflare:test";
import type { TokenIdentifier, TokenInfo, TokenPrice, TokenRef } from "@folio/tokens";
import { beforeEach, describe, expect, it } from "vitest";
import { createTokenStore } from "../src"; // 全局代币缓存:公开独立导出(非 createDb 门面)
import { getDb } from "../src/client";
import { tokenContract, tokenInfo, tokenMeta, tokenPrice, tokenWarm } from "../src/schema";

const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as TokenIdentifier });
const info = (ref: TokenRef, symbol: string, logo?: string): TokenInfo => ({
  ref,
  symbol,
  name: symbol.toUpperCase(),
  logo,
});
const price = (ref: TokenRef, unitPrice: number, rank?: number): TokenPrice => ({
  ref,
  unitPrice,
  marketCapRank: rank,
  asOf: 111,
});

// pool 不隔离每测试存储 → 每测试前清空 5 张 token 表(无 userId/FK,直接删)。
beforeEach(async () => {
  const db = getDb(env);
  await db.batch([
    db.delete(tokenWarm),
    db.delete(tokenInfo),
    db.delete(tokenPrice),
    db.delete(tokenContract),
    db.delete(tokenMeta),
  ]);
});

const TTL = 10_000;

describe("warm + candidates", () => {
  it("putWarm → getCandidates (store keys the symbol as-is; caller pre-normalizes)", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    // 键由调用方归一(store 不做);这里模拟调用方已传归一(大写)symbol。
    await store.putWarm(
      [
        { info: info(cg("usd-coin"), "USDC"), price: price(cg("usd-coin"), 1, 6) },
        { info: info(cg("usdc-x"), "USDC"), price: price(cg("usdc-x"), 0.9, 9000) },
        { info: info(cg("ethereum"), "ETH"), price: price(cg("ethereum"), 3500, 2) },
      ],
      TTL,
    );
    // 同一归一 key 下的多个候选都返回
    const cands = await store.getCandidates("USDC");
    expect(cands).toContainEqual({ ref: cg("usd-coin"), marketCapRank: 6 });
    expect(cands).toContainEqual({ ref: cg("usdc-x"), marketCapRank: 9000 });
    expect(cands).toHaveLength(2);
    expect(await store.getCandidates("ETH")).toEqual([{ ref: cg("ethereum"), marketCapRank: 2 }]);
    expect(await store.warmAsOf()).toBe(1000);
  });

  it("warm respects TTL (expired → not returned)", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.putWarm(
      [{ info: info(cg("ethereum"), "ETH"), price: price(cg("ethereum"), 3500, 2) }],
      TTL,
    );
    clock = 1000 + TTL + 1; // 过期
    expect(await store.getCandidates("ETH")).toEqual([]);
  });
});

describe("listTopTokens (rank-sorted, join name/logo)", () => {
  it("orders by marketCapRank asc (unranked last), honors limit, includes name/logo via join", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.putWarm(
      [
        { info: info(cg("ethereum"), "eth", "Lo-eth"), price: price(cg("ethereum"), 3500, 2) },
        { info: info(cg("bitcoin"), "btc", "Lo-btc"), price: price(cg("bitcoin"), 65000, 1) },
        { info: info(cg("some-fork"), "sbf", "Lo-sbf"), price: price(cg("some-fork"), 0.1) },
        { info: info(cg("solana"), "sol", "Lo-sol"), price: price(cg("solana"), 150, 5) },
      ],
      TTL,
    );
    // limit 3 → top three by rank; name/logo pulled from the info table (join worked).
    const top = await store.listTopTokens(3);
    expect(top).toEqual([
      { ref: cg("bitcoin"), symbol: "btc", name: "BTC", logo: "Lo-btc" },
      { ref: cg("ethereum"), symbol: "eth", name: "ETH", logo: "Lo-eth" },
      { ref: cg("solana"), symbol: "sol", name: "SOL", logo: "Lo-sol" },
    ]);
    expect(top.every((t) => !!t.logo)).toBe(true);
    // unranked coin sorts last, not dropped when limit allows.
    const all = await store.listTopTokens(10);
    expect(all.map((t) => t.ref.identifier)).toEqual([
      "bitcoin",
      "ethereum",
      "solana",
      "some-fork",
    ]);
  });

  it("respects TTL and source bucketing", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.putWarm(
      [{ info: info(cg("bitcoin"), "btc", "L"), price: price(cg("bitcoin"), 65000, 1) }],
      TTL,
    );
    const other = createTokenStore(env, {
      source: "coinmarketcap" as TokenRef["source"],
      now: () => clock,
    });
    expect(await other.listTopTokens(10)).toEqual([]); // 分桶:别的源看不到
    clock = 1000 + TTL + 1;
    expect(await store.listTopTokens(10)).toEqual([]); // 过期
  });
});

describe("contract cache (three-state + TTL; keys pre-normalized by caller)", () => {
  it("hit / absent / unknown", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    expect(await store.getContractRef("ethereum", "0xabc")).toBeUndefined(); // 未知

    // key(chain, contract)由调用方归一(小写);store 按 key 存/查,不自己归一。
    await store.putContractRef("ethereum", "0xabc", cg("usd-coin"), TTL);
    expect(await store.getContractRef("ethereum", "0xabc")).toEqual(cg("usd-coin")); // 命中

    await store.putContractRef("ethereum", "0xdead", null, TTL); // 否定缓存
    expect(await store.getContractRef("ethereum", "0xdead")).toBeNull();
  });

  it("expired contract → undefined (re-resolve)", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.putContractRef("ethereum", "0xabc", cg("usd-coin"), TTL);
    clock = 1000 + TTL + 1;
    expect(await store.getContractRef("ethereum", "0xabc")).toBeUndefined();
  });
});

describe("info / price round-trip", () => {
  it("putInfo/getInfo + putPrices/getPrices by refKey; miss not in map; TTL", async () => {
    let clock = 1000;
    const store = createTokenStore(env, { source: "coingecko", now: () => clock });
    await store.putInfo([info(cg("bitcoin"), "btc", "L")], TTL);
    await store.putPrices([price(cg("bitcoin"), 65000, 1)], TTL);

    const infos = await store.getInfo([cg("bitcoin"), cg("nope")]);
    expect(infos.get("coingecko:bitcoin")).toEqual({
      ref: cg("bitcoin"),
      symbol: "btc",
      name: "BTC",
      logo: "L",
    });
    expect(infos.has("coingecko:nope")).toBe(false);

    const prices = await store.getPrices([cg("bitcoin")]);
    expect(prices.get("coingecko:bitcoin")).toEqual({
      ref: cg("bitcoin"),
      unitPrice: 65000,
      marketCapRank: 1,
      asOf: 111,
    });

    clock = 1000 + TTL + 1; // 过期
    expect((await store.getInfo([cg("bitcoin")])).size).toBe(0);
    expect((await store.getPrices([cg("bitcoin")])).size).toBe(0);
  });
});

describe("source bucketing (no userId — partitioned by source)", () => {
  it("a store bound to another source sees nothing", async () => {
    const cgStore = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await cgStore.putWarm(
      [{ info: info(cg("ethereum"), "eth"), price: price(cg("ethereum"), 3500, 2) }],
      TTL,
    );
    await cgStore.putContractRef("ethereum", "0xabc", cg("usd-coin"), TTL);

    // 模拟未来另一数据源(类型上目前仅 coingecko,测试里 cast)
    const other = createTokenStore(env, {
      source: "coinmarketcap" as TokenRef["source"],
      now: () => 1000,
    });
    expect(await other.getCandidates("ETH")).toEqual([]);
    expect(await other.getContractRef("ethereum", "0xabc")).toBeUndefined();
    expect(await other.warmAsOf()).toBeNull();
    // coingecko 自己仍在
    expect(await cgStore.warmAsOf()).toBe(1000);
  });
});

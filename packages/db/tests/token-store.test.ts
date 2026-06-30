import { env } from "cloudflare:test";
import type { CoinId, TokenInfo, TokenPrice, TokenRef } from "@folio/tokens";
import { beforeEach, describe, expect, it } from "vitest";
import { createTokenStore } from "../src";
import { getDb } from "../src/client";
import { tokenContract, tokenInfo, tokenMeta, tokenPrice, tokenWarm } from "../src/schema";

const cg = (id: string): TokenRef => ({ source: "coingecko", coinId: id as CoinId });
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
  it("putWarm → getCandidates (symbol normalized, rank, warmAsOf set)", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    await store.putWarm(
      [
        { info: info(cg("usd-coin"), "usdc"), price: price(cg("usd-coin"), 1, 6) },
        { info: info(cg("usdc-x"), "USDC"), price: price(cg("usdc-x"), 0.9, 9000) },
        { info: info(cg("ethereum"), "eth"), price: price(cg("ethereum"), 3500, 2) },
      ],
      TTL,
    );
    // 大小写归一:查 "usdc" 命中两个候选
    const cands = await store.getCandidates("usdc");
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
      [{ info: info(cg("ethereum"), "eth"), price: price(cg("ethereum"), 3500, 2) }],
      TTL,
    );
    clock = 1000 + TTL + 1; // 过期
    expect(await store.getCandidates("ETH")).toEqual([]);
  });
});

describe("contract cache (three-state + TTL + lowercasing)", () => {
  it("hit / absent / unknown", async () => {
    const store = createTokenStore(env, { source: "coingecko", now: () => 1000 });
    expect(await store.getContractRef("ethereum", "0xabc")).toBeUndefined(); // 未知

    await store.putContractRef("Ethereum", "0xABC", cg("usd-coin"), TTL); // 大小写归一
    expect(await store.getContractRef("ethereum", "0xabc")).toEqual(cg("usd-coin")); // 命中
    expect(await store.getContractRef("ETHEREUM", "0xAbC")).toEqual(cg("usd-coin")); // 查询也归一

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

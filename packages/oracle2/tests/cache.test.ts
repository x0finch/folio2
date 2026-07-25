import { describe, expect, it } from "vitest";
import type { SourceToken } from "../src";
import {
  cacheKeys,
  readFx,
  readPlatform,
  refreshWarm,
  topTokens,
  warmCandidates,
  writeFx,
  writePlatform,
} from "../src/cache";
import { PLATFORM_TTL_MS, WARM_TTL_MS } from "../src/constants";
import { fakeCacheStore, fakeSource } from "./fakes";

const coin = (id: string, symbol: string, rank?: number): SourceToken => ({
  ref: `coingecko/${id}`,
  symbol,
  name: symbol,
  price: { unitPrice: 1, marketCapRank: rank, asOf: 0 },
});

describe("三种键", () => {
  it("只有 warm / fx:<币种> / platform:<键> 三种", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [coin("bitcoin", "BTC", 1)];

    await refreshWarm(cache, source, 10, cache.now);
    await writeFx(cache, "eur", 1.08);
    await writePlatform(cache, "evm:1", { name: "Ethereum", logo: "e.png" });

    expect([...cache.entries.keys()].sort()).toEqual(["fx:EUR", "platform:evm:1", "warm"]);
    expect(cacheKeys.fx(" eur ")).toBe("fx:EUR"); // 键归一在造键那一处
  });

  it("读回:汇率是数、平台是 {name, logo}", async () => {
    const cache = fakeCacheStore();
    await writeFx(cache, "EUR", 1.08);
    await writePlatform(cache, "bitcoin", { name: "Bitcoin" });

    expect(await readFx(cache, "eur")).toBe(1.08);
    expect(await readPlatform(cache, "bitcoin")).toEqual({ name: "Bitcoin" });
    expect(await readFx(cache, "JPY")).toBeUndefined();
    expect(await readPlatform(cache, "nope")).toBeUndefined();
  });

  it("TTL 语义:warm 短、平台名图长", async () => {
    const cache = fakeCacheStore();
    await refreshWarm(cache, fakeSource(), 10, cache.now);
    await writePlatform(cache, "evm:1", { name: "Ethereum" });

    const base = cache.now;
    expect(cache.entries.get("warm")?.expiresAt).toBe(base + WARM_TTL_MS);
    expect(cache.entries.get("platform:evm:1")?.expiresAt).toBe(base + PLATFORM_TTL_MS);
    expect(PLATFORM_TTL_MS).toBeGreaterThan(WARM_TTL_MS);
  });
});

describe("warm 刷新", () => {
  it("是一次整份写,不是逐行 upsert", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [
      coin("bitcoin", "BTC", 1),
      coin("ethereum", "ETH", 2),
      coin("tether", "USDT", 3),
    ];

    expect(await refreshWarm(cache, source, 50, cache.now)).toBe(true);
    expect(cache.writes).toBe(1); // 三个币,一次写
    expect(cache.entries.size).toBe(1);
  });

  it("TTL 门控:没过期就不拉上游;过期了才拉", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [coin("bitcoin", "BTC", 1)];

    await refreshWarm(cache, source, 50, cache.now);
    expect(await refreshWarm(cache, source, 50, cache.now)).toBe(false);
    expect(source.calls).toEqual(["fetchMarkets:50"]); // 只拉过一次

    cache.now += WARM_TTL_MS + 1;
    expect(await refreshWarm(cache, source, 50, cache.now)).toBe(true);
    expect(source.calls).toHaveLength(2);
  });
});

describe("排行榜与 symbol 候选出自同一个 blob", () => {
  it("取前 N 名按市值升序,无 rank 者垫底", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [
      coin("tether", "USDT", 3),
      coin("nameless", "XXX"),
      coin("bitcoin", "BTC", 1),
    ];
    await refreshWarm(cache, source, 50, cache.now);

    expect((await topTokens(cache, 2)).map((t) => t.ref)).toEqual([
      "coingecko/bitcoin",
      "coingecko/tether",
    ]);
    expect((await topTokens(cache, 9)).at(-1)?.ref).toBe("coingecko/nameless");
  });

  it("按 symbol 取候选不额外存一份 —— 写完 warm 之后缓存里仍只有一个键", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [coin("usd-coin", "USDC", 6), coin("fake-usdc", "usdc", 4200)];
    await refreshWarm(cache, source, 50, cache.now);

    expect(await warmCandidates(cache).bySymbol("usdc")).toEqual([
      { coinId: "usd-coin", marketCapRank: 6 },
      { coinId: "fake-usdc", marketCapRank: 4200 },
    ]);
    expect([...cache.entries.keys()]).toEqual(["warm"]);
  });

  it("symbol 归一同口径(大小写/空白不影响命中)", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [coin("bitcoin", "btc", 1)];
    await refreshWarm(cache, source, 50, cache.now);

    expect(await warmCandidates(cache).bySymbol("  BTC ")).toEqual([
      { coinId: "bitcoin", marketCapRank: 1 },
    ]);
  });
});

describe("整张清空", () => {
  it("功能不坏,只是读出空 —— 调用方降级到回源", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [coin("bitcoin", "BTC", 1)];
    await refreshWarm(cache, source, 50, cache.now);

    cache.entries.clear();
    expect(await topTokens(cache, 10)).toEqual([]);
    expect(await warmCandidates(cache).bySymbol("BTC")).toEqual([]);
    expect(await readFx(cache, "EUR")).toBeUndefined();
    // 下一次刷新照常把它填回来。
    expect(await refreshWarm(cache, source, 50, cache.now)).toBe(true);
  });
});

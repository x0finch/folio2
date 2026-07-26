import { describe, expect, it } from "vitest";
import type { SourceToken } from "../src";
import {
  cacheKeys,
  candidatesBySymbol,
  PLATFORM_TTL_MS,
  readFx,
  readPlatform,
  topByRank,
  WARM_TTL_MS,
  warmRows,
  writeFx,
  writePlatform,
} from "../src";
import { fakeCacheStore, fakeSource } from "./fakes";

const coin = (id: string, symbol: string, rank?: number): SourceToken => ({
  ref: `src/${id}`,
  symbol,
  name: symbol,
  price: { unitPrice: 1, marketCapRank: rank, asOf: 0 },
});

describe("三种键", () => {
  it("只有 warm / fx:<币种> / platform:<键> 三种", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [coin("bitcoin", "BTC", 1)];

    await warmRows(cache, source, 10, cache.now);
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
    await warmRows(cache, fakeSource(), 10, cache.now);
    await writePlatform(cache, "evm:1", { name: "Ethereum" });

    expect(cache.entries.get("warm")?.expiresAt).toBe(cache.now + WARM_TTL_MS);
    expect(cache.entries.get("platform:evm:1")?.expiresAt).toBe(cache.now + PLATFORM_TTL_MS);
    expect(PLATFORM_TTL_MS).toBeGreaterThan(WARM_TTL_MS);
  });
});

describe("warm 走 SWR,一次整份写", () => {
  it("三个币一次写;没过期就不拉上游", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [
      coin("bitcoin", "BTC", 1),
      coin("ethereum", "ETH", 2),
      coin("tether", "USDT", 3),
    ];

    expect(await warmRows(cache, source, 50, cache.now)).toHaveLength(3);
    expect(cache.writes).toBe(1); // 三个币,一次写
    expect(cache.entries.size).toBe(1);

    await warmRows(cache, source, 50, cache.now);
    expect(source.calls).toEqual(["fetchMarkets:50"]); // 只拉过一次
  });

  it("过期了才重拉(SWR 的 stale 分支)", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [coin("bitcoin", "BTC", 1)];
    await warmRows(cache, source, 50, cache.now);

    cache.now += WARM_TTL_MS + 1;
    await warmRows(cache, source, 50, cache.now);
    expect(source.calls).toHaveLength(2);
  });

  it("上游挂了 → 给旧的那份,不抛(SWR 兜的)", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [coin("bitcoin", "BTC", 1)];
    await warmRows(cache, source, 50, cache.now);

    cache.now += WARM_TTL_MS + 1;
    source.fetchMarkets = async () => {
      throw new Error("429");
    };
    expect(await warmRows(cache, source, 50, cache.now)).toHaveLength(1);
  });
});

describe("排行榜与 symbol 候选出自同一份 rows", () => {
  it("取前 N 名按市值升序,无 rank 者垫底", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [
      coin("tether", "USDT", 3),
      coin("nameless", "XXX"),
      coin("bitcoin", "BTC", 1),
    ];
    const rows = await warmRows(cache, source, 50, cache.now);

    expect(topByRank(rows, 2).map((r) => r.info.ref)).toEqual(["src/bitcoin", "src/tether"]);
    expect(topByRank(rows, 9).at(-1)?.info.ref).toBe("src/nameless");
  });

  it("按 symbol 取候选不额外存一份 —— 缓存里仍只有一个键", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [coin("usd-coin", "USDC", 6), coin("fake-usdc", "usdc", 4200)];
    const rows = await warmRows(cache, source, 50, cache.now);

    expect(candidatesBySymbol(rows, "usdc")).toEqual([
      { ref: "src/usd-coin", marketCapRank: 6 },
      { ref: "src/fake-usdc", marketCapRank: 4200 },
    ]);
    expect([...cache.entries.keys()]).toEqual(["warm"]);
  });

  it("symbol 归一同口径(大小写/空白不影响命中)", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [coin("bitcoin", "btc", 1)];
    const rows = await warmRows(cache, source, 50, cache.now);
    expect(candidatesBySymbol(rows, "  BTC ")).toEqual([{ ref: "src/bitcoin", marketCapRank: 1 }]);
  });
});

describe("整张清空", () => {
  it("功能不坏,下一次访问自己填回来", async () => {
    const cache = fakeCacheStore();
    const source = fakeSource();
    source.markets = [coin("bitcoin", "BTC", 1)];
    await warmRows(cache, source, 50, cache.now);

    cache.entries.clear();
    expect(await readFx(cache, "EUR")).toBeUndefined();
    expect(await warmRows(cache, source, 50, cache.now)).toHaveLength(1);
    expect(source.calls).toHaveLength(2);
  });
});

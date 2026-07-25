import {
  cgkRef,
  MS_PER_DAY,
  TokenError,
  type TokenPriceHistoryStore,
  type TokenPricePoint,
  type TokenRef,
  type TokenSource,
  type TokenStore,
} from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { createTokens } from "../src/services/tokens";

// Tokens.priceSeries / priceAt(#148 / ADR 0019):缓存日桶合并 + 一次回源补缺 + 降级。
// 用 2020 时间戳(相对 now 恒为过去)→ 今日桶分支不触发,行为确定。
const cg = cgkRef;
const noopStore = () => ({}) as unknown as TokenStore;

const B0 = 18500;
const B1 = 18501;
const B2 = 18502;
const day = (b: number, offsetMs = 0): number => b * MS_PER_DAY + offsetMs;

// 进程内历史价缓存(跨调用保留 → 验证第二次全命中)。
function inMemoryHistory(): TokenPriceHistoryStore {
  const rows = new Map<string, number>();
  const k = (ref: TokenRef, b: number) => `${ref}:${b}`;
  return {
    async getDailyPrices(ref, buckets) {
      const out = new Map<number, number>();
      for (const b of buckets) {
        const v = rows.get(k(ref, b));
        if (v !== undefined) out.set(b, v);
      }
      return out;
    },
    async putDailyPrices(ref, prices) {
      for (const p of prices) rows.set(k(ref, p.dayBucket), p.unitPrice);
    },
  };
}

function fakeSource(points: TokenPricePoint[]): TokenSource & { calls: number } {
  const s = {
    calls: 0,
    namer: "coingecko",
    fetchMarkets: async () => [],
    fetchByContract: async () => null,
    fetchPrices: async () => new Map(),
    searchTokens: async () => [],
    async fetchPriceSeries() {
      s.calls++;
      return points;
    },
  };
  return s;
}

function throwingSource(): TokenSource {
  return {
    namer: "coingecko",
    fetchMarkets: async () => [],
    fetchByContract: async () => null,
    fetchPrices: async () => new Map(),
    searchTokens: async () => [],
    async fetchPriceSeries() {
      throw new TokenError("UPSTREAM_ERROR", "boom", { retryable: true });
    },
  };
}

describe("Tokens.priceSeries", () => {
  it("一次回源 → 按 UTC 日桶归一(当日最后一点胜出),升序返回日价点", async () => {
    const src = fakeSource([
      { atMs: day(B0, 3_600_000), unitPrice: 60000 },
      { atMs: day(B0, 7_200_000), unitPrice: 60500 }, // 同日后点 → 覆盖
      { atMs: day(B1), unitPrice: 61000 },
      { atMs: day(B2), unitPrice: 62000 },
    ]);
    const tokens = createTokens({
      createStore: noopStore,
      createPriceHistoryStore: inMemoryHistory,
      source: src,
    });
    const out = await tokens.priceSeries(cg("bitcoin"), day(B0), day(B2));
    expect(out).toEqual([
      { atMs: day(B0), unitPrice: 60500 },
      { atMs: day(B1), unitPrice: 61000 },
      { atMs: day(B2), unitPrice: 62000 },
    ]);
    expect(src.calls).toBe(1);
  });

  it("过去区间第二次调用 → 全命中缓存,不再回源", async () => {
    const hist = inMemoryHistory();
    const src = fakeSource([
      { atMs: day(B0), unitPrice: 60000 },
      { atMs: day(B1), unitPrice: 61000 },
    ]);
    const tokens = createTokens({
      createStore: noopStore,
      createPriceHistoryStore: () => hist,
      source: src,
    });
    await tokens.priceSeries(cg("bitcoin"), day(B0), day(B1)); // 首取 → 落缓存
    expect(src.calls).toBe(1);
    const out = await tokens.priceSeries(cg("bitcoin"), day(B0), day(B1));
    expect(src.calls).toBe(1); // 第二次零回源
    expect(out.map((p) => p.unitPrice)).toEqual([60000, 61000]);
  });

  it("上游失败 → 降级到仅缓存(冷则空),不抛", async () => {
    const tokens = createTokens({
      createStore: noopStore,
      createPriceHistoryStore: inMemoryHistory,
      source: throwingSource(),
    });
    await expect(tokens.priceSeries(cg("bitcoin"), day(B0), day(B1))).resolves.toEqual([]);
  });

  it("非本源 / from>to → 空,不回源", async () => {
    const src = fakeSource([{ atMs: day(B0), unitPrice: 1 }]);
    const tokens = createTokens({
      createStore: noopStore,
      createPriceHistoryStore: inMemoryHistory,
      source: src,
    });
    expect(await tokens.priceSeries(cg("bitcoin"), day(B2), day(B0))).toEqual([]); // from>to
    expect(src.calls).toBe(0);
  });
});

describe("Tokens.priceAt", () => {
  it("返回 atMs 所属日桶价;该日无数据 → undefined", async () => {
    const src = fakeSource([
      { atMs: day(B0), unitPrice: 60000 },
      { atMs: day(B1), unitPrice: 61000 },
    ]);
    const tokens = createTokens({
      createStore: noopStore,
      createPriceHistoryStore: inMemoryHistory,
      source: src,
    });
    expect(await tokens.priceAt(cg("bitcoin"), day(B1, 5000))).toBe(61000);
    // B0-100 是更早的一天,源不返回该日 → undefined(调用方降级)。
    expect(await tokens.priceAt(cg("bitcoin"), day(B0 - 100))).toBeUndefined();
  });
});

import { describe, expect, it } from "vitest";
import type { Token } from "../src";
import { MS_PER_DAY, PRICE_TTL_MS } from "../src/constants";
import { createTokens } from "../src/tokens";
import { fakeCacheStore, fakeSource, fakeTokenStore } from "./fakes";

const NOW = 1_700_000_000_000; // 落在某个 UTC 日的中段
const TODAY = Math.floor(NOW / MS_PER_DAY);
const CGK_BTC = "coingecko/bitcoin";

const token = (over: Partial<Token> & { id: string }): Token => ({
  symbol: "BTC",
  name: "Bitcoin",
  ...over,
});

function setup(rows: Token[] = []) {
  const store = fakeTokenStore(rows);
  const cache = fakeCacheStore();
  const source = fakeSource();
  const tokens = createTokens({ store, cache, source, now: () => NOW });
  return { store, cache, source, tokens };
}

describe("富化", () => {
  it("按 token_id 取,输入不再需要 symbol 或 tokenRef", async () => {
    const { tokens } = setup([
      token({ id: "tk_1", cgkCoinId: "bitcoin", logo: "b.png", marketCapRank: 1 }),
      token({ id: "tk_2", symbol: "WAT", name: "Whatever", providerLogo: "p.png" }),
    ]);
    const got = await tokens.byIds(["tk_1", "tk_2", "tk_missing"]);

    expect(got.size).toBe(2);
    expect(got.get("tk_1")).toMatchObject({ symbol: "BTC", logo: "b.png", marketCapRank: 1 });
    expect(got.get("tk_2")).toMatchObject({ symbol: "WAT", providerLogo: "p.png" });
  });

  it("空输入不查库", async () => {
    const { tokens } = setup();
    expect(await tokens.byIds([])).toEqual(new Map());
  });

  it("「有没有被 CoinGecko 认出来」就看 cgkCoinId,不存额外状态", async () => {
    const { tokens } = setup([
      token({ id: "tk_1", cgkCoinId: "bitcoin" }),
      token({ id: "tk_2", symbol: "WAT" }),
    ]);
    const got = await tokens.byIds(["tk_1", "tk_2"]);

    expect(got.get("tk_1")?.cgkCoinId).toBe("bitcoin");
    expect(got.get("tk_2")?.cgkCoinId).toBeUndefined();
    // 没有第三种状态可查 —— 行上没有孤儿标记、没有复查时刻。
    expect(Object.keys(got.get("tk_2") as object).sort()).toEqual(["id", "name", "symbol"]);
  });

  it("logo 回退链:CoinGecko 的优先,没有就用 provider 那张", async () => {
    const { tokens } = setup([
      token({ id: "tk_1", logo: "cgk.png", providerLogo: "p.png" }),
      token({ id: "tk_2", providerLogo: "p.png" }),
      token({ id: "tk_3" }),
    ]);
    expect(await tokens.logoUrlById("tk_1")).toBe("cgk.png");
    expect(await tokens.logoUrlById("tk_2")).toBe("p.png");
    expect(await tokens.logoUrlById("tk_3")).toBeUndefined();
    expect(await tokens.logoUrlById("nope")).toBeUndefined();
  });
});

describe("取价(SWR)", () => {
  const fresh = { unitPrice: 60000, change24h: 1.5, asOf: NOW, stale: false };

  it("新鲜 → 直接回,不碰上游", async () => {
    const { source, tokens } = setup([token({ id: "tk_1", cgkCoinId: "bitcoin", price: fresh })]);
    expect(await tokens.priceOf("tk_1")).toEqual(fresh);
    expect(source.calls).toEqual([]);
  });

  it("stale → 回源 → 写回(长尾币按需取价走这条)", async () => {
    const { store, source, tokens } = setup([
      token({ id: "tk_1", cgkCoinId: "bitcoin", price: { ...fresh, stale: true } }),
    ]);
    source.prices.set(CGK_BTC, { unitPrice: 61000, change24h: 2, asOf: NOW });

    expect(await tokens.priceOf("tk_1")).toMatchObject({ unitPrice: 61000, stale: false });
    expect(source.calls).toEqual([`fetchPrices:${CGK_BTC}`]);
    expect(store.rows.get("tk_1")?.price?.unitPrice).toBe(61000); // 写回了
  });

  it("认不出来的币取不了价 —— 不问上游,把旧值原样给出去", async () => {
    const { source, tokens } = setup([
      token({ id: "tk_1", symbol: "WAT", price: { ...fresh, stale: true } }),
    ]);
    expect(await tokens.priceOf("tk_1")).toMatchObject({ unitPrice: 60000, stale: true });
    expect(source.calls).toEqual([]);
  });

  it("上游也没有 → 保留旧值(过期不删)", async () => {
    const { store, tokens } = setup([
      token({ id: "tk_1", cgkCoinId: "bitcoin", price: { ...fresh, stale: true } }),
    ]);
    expect(await tokens.priceOf("tk_1")).toMatchObject({ unitPrice: 60000 });
    expect(store.rows.get("tk_1")?.price?.unitPrice).toBe(60000);
  });
});

describe("批量刷 stale 价", () => {
  it("只刷「认得出来且价 stale/缺失」的,一次批量回源", async () => {
    const { source, tokens } = setup([
      token({
        id: "fresh",
        cgkCoinId: "bitcoin",
        price: { unitPrice: 1, asOf: NOW, stale: false },
      }),
      token({ id: "stale", cgkCoinId: "ethereum", price: { unitPrice: 1, asOf: 0, stale: true } }),
      token({ id: "nopricexyz", cgkCoinId: "tether" }),
      token({ id: "unknown", symbol: "WAT" }), // 认不出来 → 跳过
    ]);
    source.prices.set("coingecko/ethereum", { unitPrice: 3000, asOf: NOW });
    source.prices.set("coingecko/tether", { unitPrice: 1, asOf: NOW });

    const n = await tokens.refreshStalePrices(["fresh", "stale", "nopricexyz", "unknown"]);
    expect(n).toBe(2);
    expect(source.calls).toEqual(["fetchPrices:coingecko/ethereum,coingecko/tether"]);
  });

  it("没有要刷的 → 零调用", async () => {
    const { source, tokens } = setup([
      token({ id: "tk_1", cgkCoinId: "bitcoin", price: { unitPrice: 1, asOf: NOW, stale: false } }),
    ]);
    expect(await tokens.refreshStalePrices(["tk_1"])).toBe(0);
    expect(await tokens.refreshStalePrices([])).toBe(0);
    expect(source.calls).toEqual([]);
  });

  it("写回带 TTL(过期只标 stale,不删行)", async () => {
    const { store, source, tokens } = setup([token({ id: "tk_1", cgkCoinId: "bitcoin" })]);
    source.prices.set(CGK_BTC, { unitPrice: 60000, asOf: NOW });
    await tokens.refreshStalePrices(["tk_1"]);

    store.now = NOW + PRICE_TTL_MS + 1;
    expect(store.rows.get("tk_1")?.price?.unitPrice).toBe(60000); // 行还在
  });
});

describe("历史日价(按 token_id)", () => {
  const day = (offset: number) => (TODAY + offset) * MS_PER_DAY;

  it("范围查:缓存命中的过去日直接用,缺的一次回源补齐并落缓存", async () => {
    const { store, source, tokens } = setup([token({ id: "tk_1", cgkCoinId: "bitcoin" })]);
    await store.putDailyPrices("tk_1", [{ dayBucket: TODAY - 3, unitPrice: 100 }]);
    source.series = [
      { atMs: day(-2), unitPrice: 200 },
      { atMs: day(-1), unitPrice: 300 },
    ];

    const series = await tokens.priceSeries("tk_1", day(-3), day(-1));
    expect(series).toEqual([
      { atMs: day(-3), unitPrice: 100 },
      { atMs: day(-2), unitPrice: 200 },
      { atMs: day(-1), unitPrice: 300 },
    ]);
    // 补齐的两天永久落了缓存(过去日不可变)。
    expect(await store.getDailyPrices("tk_1", [TODAY - 2, TODAY - 1])).toEqual(
      new Map([
        [TODAY - 2, 200],
        [TODAY - 1, 300],
      ]),
    );
  });

  it("全部命中缓存 → 不碰上游", async () => {
    const { store, source, tokens } = setup([token({ id: "tk_1", cgkCoinId: "bitcoin" })]);
    await store.putDailyPrices("tk_1", [
      { dayBucket: TODAY - 2, unitPrice: 1 },
      { dayBucket: TODAY - 1, unitPrice: 2 },
    ]);
    expect(await tokens.priceSeries("tk_1", day(-2), day(-1))).toHaveLength(2);
    expect(source.calls).toEqual([]);
  });

  it("今日桶恒现取、不落缓存(它还会变)", async () => {
    const { store, source, tokens } = setup([token({ id: "tk_1", cgkCoinId: "bitcoin" })]);
    source.series = [{ atMs: NOW, unitPrice: 999 }];

    expect(await tokens.priceSeries("tk_1", day(0), NOW)).toEqual([
      { atMs: day(0), unitPrice: 999 },
    ]);
    expect(await store.getDailyPrices("tk_1", [TODAY])).toEqual(new Map());
    // 第二次照样回源。
    await tokens.priceSeries("tk_1", day(0), NOW);
    expect(source.calls).toHaveLength(2);
  });

  it("上游失败 → 退回仅缓存,不抛", async () => {
    const { store, source, tokens } = setup([token({ id: "tk_1", cgkCoinId: "bitcoin" })]);
    await store.putDailyPrices("tk_1", [{ dayBucket: TODAY - 2, unitPrice: 7 }]);
    source.fetchPriceSeries = async () => {
      throw new Error("429");
    };

    expect(await tokens.priceSeries("tk_1", day(-2), day(-1))).toEqual([
      { atMs: day(-2), unitPrice: 7 },
    ]);
  });

  it("认不出来的币 / 反向区间 → 空,不碰上游", async () => {
    const { source, tokens } = setup([
      token({ id: "unknown", symbol: "WAT" }),
      token({ id: "tk_1", cgkCoinId: "bitcoin" }),
    ]);
    expect(await tokens.priceSeries("unknown", day(-2), day(-1))).toEqual([]);
    expect(await tokens.priceSeries("tk_1", day(-1), day(-2))).toEqual([]);
    expect(source.calls).toEqual([]);
  });

  it("priceAt 取该 UTC 日桶的价;那天没数据 → undefined", async () => {
    const { store, tokens } = setup([token({ id: "tk_1", cgkCoinId: "bitcoin" })]);
    await store.putDailyPrices("tk_1", [{ dayBucket: TODAY - 5, unitPrice: 42 }]);

    expect(await tokens.priceAt("tk_1", day(-5) + 3600_000)).toBe(42);
    expect(await tokens.priceAt("tk_1", day(-6))).toBeUndefined();
  });
});

describe("选币橱窗", () => {
  it("走 warm blob;冷缓存 → 先预热一次再读", async () => {
    const { source, tokens } = setup();
    source.markets = [
      {
        ref: CGK_BTC,
        symbol: "BTC",
        name: "Bitcoin",
        price: { unitPrice: 60000, marketCapRank: 1, asOf: NOW },
      },
    ];

    expect((await tokens.topTokens(10)).map((t) => t.ref)).toEqual([CGK_BTC]);
    expect(source.calls).toEqual(["fetchMarkets:1000"]);
    // 第二次直接从 blob 出,不再预热。
    await tokens.topTokens(10);
    expect(source.calls).toHaveLength(1);
  });

  it("预热失败不抛,返回空让调用方降级", async () => {
    const { source, tokens } = setup();
    source.fetchMarkets = async () => {
      throw new Error("429");
    };
    expect(await tokens.topTokens(10)).toEqual([]);
  });

  it("搜索恒回源(结果与用户无关)", async () => {
    const { source, tokens } = setup();
    source.searchResults = [{ ref: CGK_BTC, symbol: "BTC", name: "Bitcoin" }];
    expect(await tokens.search("bit")).toHaveLength(1);
    expect(source.calls).toEqual(["searchTokens:bit"]);
  });
});

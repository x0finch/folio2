import { describe, expect, it } from "vitest";
import { createTokens, MS_PER_DAY, PRICE_TTL_MS, type TokenInfo } from "../src";
import { fakeCacheStore, fakeSource, fakeTokenPriceStore, fakeTokenStore } from "./fakes";

const NOW = 1_700_000_000_000; // 落在某个 UTC 日的中段
const TODAY = Math.floor(NOW / MS_PER_DAY);
const SRC_BTC = "src/bitcoin";

const info = (over: Partial<TokenInfo> & { id: string }): TokenInfo => ({
  ref: SRC_BTC,
  symbol: "BTC",
  name: "Bitcoin",
  ...over,
});

function setup(rows: TokenInfo[] = []) {
  const store = fakeTokenStore(rows);
  const prices = fakeTokenPriceStore();
  const cache = fakeCacheStore();
  const source = fakeSource();
  const tokens = createTokens({ store, prices, cache, source, now: () => NOW });
  return { store, prices, cache, source, tokens };
}

describe("富化 —— 两个 store 各读自己那半,服务层合成整行", () => {
  it("按 token_id 取,输入不再需要 symbol 或 tokenRef", async () => {
    const { prices, tokens } = setup([
      info({ id: "tk_1", logo: "b.png" }),
      info({ id: "tk_2", ref: null, symbol: "WAT", name: "Whatever", providerLogo: "p.png" }),
    ]);
    await prices.put(
      [{ tokenId: "tk_1", unitPrice: 60000, marketCapRank: 1, asOf: NOW }],
      PRICE_TTL_MS,
    );

    const got = await tokens.enrich(["tk_1", "tk_2", "tk_missing"]);
    expect(got.size).toBe(2);
    expect(got.get("tk_1")).toMatchObject({ symbol: "BTC", logo: "b.png" });
    expect(got.get("tk_1")?.price).toMatchObject({
      unitPrice: 60000,
      marketCapRank: 1,
      stale: false,
    });
    expect(got.get("tk_2")?.price).toBeUndefined(); // 没价的行照样出 info
  });

  it("空输入不查库", async () => {
    const { tokens } = setup();
    expect(await tokens.enrich([])).toEqual(new Map());
  });

  it("「上游认没认出来」就看 ref 空不空,不存额外状态", async () => {
    const { tokens } = setup([
      info({ id: "tk_1" }),
      info({ id: "tk_2", ref: null, symbol: "WAT" }),
    ]);
    const got = await tokens.enrich(["tk_1", "tk_2"]);

    expect(got.get("tk_1")?.ref).toBe(SRC_BTC);
    expect(got.get("tk_2")?.ref).toBeNull();
    // 行上没有孤儿标记、没有复查时刻,也没有任何带数据源名字的字段。
    const keys = Object.keys(got.get("tk_2") as object);
    expect(keys.some((k) => /cgk|coingecko|coin_?id|orphan|recheck/i.test(k))).toBe(false);
  });

  it("logo 回退链:源给的优先,没有就用连接器自带那张", async () => {
    const { tokens } = setup([
      info({ id: "tk_1", logo: "up.png", providerLogo: "p.png" }),
      info({ id: "tk_2", logo: undefined, providerLogo: "p.png" }),
      info({ id: "tk_3", logo: undefined }),
    ]);
    expect(await tokens.logoUrlById("tk_1")).toBe("up.png");
    expect(await tokens.logoUrlById("tk_2")).toBe("p.png");
    expect(await tokens.logoUrlById("tk_3")).toBeUndefined();
    expect(await tokens.logoUrlById("nope")).toBeUndefined();
  });
});

describe("取价 —— 走同一个 SWR 编排", () => {
  it("新鲜 → 直接回,不碰上游", async () => {
    const { prices, source, tokens } = setup([info({ id: "tk_1" })]);
    await prices.put([{ tokenId: "tk_1", unitPrice: 60000, asOf: NOW }], PRICE_TTL_MS);
    expect(await tokens.priceOf("tk_1")).toMatchObject({ unitPrice: 60000, stale: false });
    expect(source.calls).toEqual([]);
  });

  it("stale → 回源 → 写回(长尾币按需取价走这条)", async () => {
    const { prices, source, tokens } = setup([info({ id: "tk_1" })]);
    await prices.put([{ tokenId: "tk_1", unitPrice: 60000, asOf: 0 }], PRICE_TTL_MS);
    prices.now = NOW + PRICE_TTL_MS + 1;
    source.prices.set(SRC_BTC, { unitPrice: 61000, asOf: NOW });

    expect(await tokens.priceOf("tk_1")).toMatchObject({ unitPrice: 61000 });
    expect(source.calls).toEqual([`fetchPrices:${SRC_BTC}`]);
    expect(prices.current.get("tk_1")?.price.unitPrice).toBe(61000); // 写回了
  });

  it("上游还没认出的币取不了价 —— 不问上游,把旧值原样给出去", async () => {
    const { prices, source, tokens } = setup([info({ id: "tk_1", ref: null })]);
    await prices.put([{ tokenId: "tk_1", unitPrice: 42, asOf: 0 }], 0);
    expect(await tokens.priceOf("tk_1")).toMatchObject({ unitPrice: 42, stale: true });
    expect(source.calls).toEqual([]);
  });

  it("上游也没有 → 保留旧值(过期不删)", async () => {
    const { prices, tokens } = setup([info({ id: "tk_1" })]);
    await prices.put([{ tokenId: "tk_1", unitPrice: 60000, asOf: 0 }], 0);
    expect(await tokens.priceOf("tk_1")).toMatchObject({ unitPrice: 60000 });
    expect(prices.current.get("tk_1")?.price.unitPrice).toBe(60000);
  });
});

describe("批量刷 stale 价", () => {
  it("只刷「认得出来且价 stale/缺失」的,一次批量回源", async () => {
    const { prices, source, tokens } = setup([
      info({ id: "fresh" }),
      info({ id: "stale", ref: "src/ethereum" }),
      info({ id: "nopricexyz", ref: "src/tether" }),
      info({ id: "unknown", ref: null }), // 上游没认出 → 跳过
    ]);
    await prices.put([{ tokenId: "fresh", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
    await prices.put([{ tokenId: "stale", unitPrice: 1, asOf: 0 }], 0);
    source.prices.set("src/ethereum", { unitPrice: 3000, asOf: NOW });
    source.prices.set("src/tether", { unitPrice: 1, asOf: NOW });

    expect(await tokens.refreshStalePrices(["fresh", "stale", "nopricexyz", "unknown"])).toBe(2);
    expect(source.calls).toEqual(["fetchPrices:src/ethereum,src/tether"]);
  });

  it("没有要刷的 → 零调用", async () => {
    const { prices, source, tokens } = setup([info({ id: "tk_1" })]);
    await prices.put([{ tokenId: "tk_1", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
    expect(await tokens.refreshStalePrices(["tk_1"])).toBe(0);
    expect(await tokens.refreshStalePrices([])).toBe(0);
    expect(source.calls).toEqual([]);
  });
});

describe("历史日价(按 token_id)", () => {
  const day = (offset: number) => (TODAY + offset) * MS_PER_DAY;

  it("范围查:缓存命中的过去日直接用,缺的一次回源补齐并落缓存", async () => {
    const { prices, source, tokens } = setup([info({ id: "tk_1" })]);
    await prices.putDaily("tk_1", [{ dayBucket: TODAY - 3, unitPrice: 100 }]);
    source.series = [
      { atMs: day(-2), unitPrice: 200 },
      { atMs: day(-1), unitPrice: 300 },
    ];

    expect(await tokens.priceSeries("tk_1", day(-3), day(-1))).toEqual([
      { atMs: day(-3), unitPrice: 100 },
      { atMs: day(-2), unitPrice: 200 },
      { atMs: day(-1), unitPrice: 300 },
    ]);
    // 补齐的两天永久落了缓存(过去日不可变)。
    expect(await prices.getDaily("tk_1", [TODAY - 2, TODAY - 1])).toEqual(
      new Map([
        [TODAY - 2, 200],
        [TODAY - 1, 300],
      ]),
    );
  });

  it("全部命中缓存 → 不碰上游", async () => {
    const { prices, source, tokens } = setup([info({ id: "tk_1" })]);
    await prices.putDaily("tk_1", [
      { dayBucket: TODAY - 2, unitPrice: 1 },
      { dayBucket: TODAY - 1, unitPrice: 2 },
    ]);
    expect(await tokens.priceSeries("tk_1", day(-2), day(-1))).toHaveLength(2);
    expect(source.calls).toEqual([]);
  });

  it("今日桶恒现取、不落缓存(它还会变)", async () => {
    const { prices, source, tokens } = setup([info({ id: "tk_1" })]);
    source.series = [{ atMs: NOW, unitPrice: 999 }];

    expect(await tokens.priceSeries("tk_1", day(0), NOW)).toEqual([
      { atMs: day(0), unitPrice: 999 },
    ]);
    expect(await prices.getDaily("tk_1", [TODAY])).toEqual(new Map());
    await tokens.priceSeries("tk_1", day(0), NOW);
    expect(source.calls).toHaveLength(2); // 第二次照样回源
  });

  it("上游失败 → 退回仅缓存,不抛", async () => {
    const { prices, source, tokens } = setup([info({ id: "tk_1" })]);
    await prices.putDaily("tk_1", [{ dayBucket: TODAY - 2, unitPrice: 7 }]);
    source.fetchPriceSeries = async () => {
      throw new Error("429");
    };
    expect(await tokens.priceSeries("tk_1", day(-2), day(-1))).toEqual([
      { atMs: day(-2), unitPrice: 7 },
    ]);
  });

  it("上游没认出的币 / 反向区间 → 空,不碰上游", async () => {
    const { source, tokens } = setup([info({ id: "unknown", ref: null }), info({ id: "tk_1" })]);
    expect(await tokens.priceSeries("unknown", day(-2), day(-1))).toEqual([]);
    expect(await tokens.priceSeries("tk_1", day(-1), day(-2))).toEqual([]);
    expect(source.calls).toEqual([]);
  });

  it("priceAt 取该 UTC 日桶的价;那天没数据 → undefined", async () => {
    const { prices, tokens } = setup([info({ id: "tk_1" })]);
    await prices.putDaily("tk_1", [{ dayBucket: TODAY - 5, unitPrice: 42 }]);
    expect(await tokens.priceAt("tk_1", day(-5) + 3_600_000)).toBe(42);
    expect(await tokens.priceAt("tk_1", day(-6))).toBeUndefined();
  });
});

describe("橱窗与候选", () => {
  it("排行榜走 warm(经 SWR 预热一次);候选与它同一份 rows", async () => {
    const { source, cache, tokens } = setup();
    source.markets = [
      {
        ref: SRC_BTC,
        symbol: "BTC",
        name: "Bitcoin",
        price: { unitPrice: 60000, marketCapRank: 1, asOf: NOW },
      },
      {
        ref: "src/tether",
        symbol: "USDT",
        name: "Tether",
        price: { unitPrice: 1, marketCapRank: 3, asOf: NOW },
      },
    ];

    expect((await tokens.topTokens(1)).map((t) => t.ref)).toEqual([SRC_BTC]);
    expect(source.calls).toEqual(["fetchMarkets:1000"]);
    // 第二次从 blob 出,不再预热;候选也从同一份出 → 缓存里始终只有一个键。
    expect(await tokens.candidates.bySymbol("USDT")).toEqual([
      { ref: "src/tether", marketCapRank: 3 },
    ]);
    expect(source.calls).toHaveLength(1);
    expect([...cache.entries.keys()]).toEqual(["warm"]);
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
    source.searchResults = [{ ref: SRC_BTC, symbol: "BTC", name: "Bitcoin" }];
    expect(await tokens.search("bit")).toHaveLength(1);
    expect(source.calls).toEqual(["searchTokens:bit"]);
  });
});

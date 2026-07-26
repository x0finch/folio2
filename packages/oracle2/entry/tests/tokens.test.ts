import { describe, expect, it } from "vitest";
import { createTokens, dayBucketOf, MS_PER_DAY, PRICE_TTL_MS, type TokenInfo } from "../src";
import { fakeCacheStore, fakeTokenPriceStore, fakeTokenStore, fakeUpstream } from "./fakes";

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
  const upstream = fakeUpstream();
  const tokens = createTokens({ store, prices, cache, upstream, now: () => NOW });
  return { store, prices, cache, upstream, tokens };
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
    const { prices, upstream, tokens } = setup([info({ id: "tk_1" })]);
    await prices.put([{ tokenId: "tk_1", unitPrice: 60000, asOf: NOW }], PRICE_TTL_MS);
    expect(await tokens.priceOf("tk_1")).toMatchObject({ unitPrice: 60000, stale: false });
    expect(upstream.calls).toEqual([]);
  });

  it("stale → 回源 → 写回(长尾币按需取价走这条)", async () => {
    const { prices, upstream, tokens } = setup([info({ id: "tk_1" })]);
    await prices.put([{ tokenId: "tk_1", unitPrice: 60000, asOf: 0 }], PRICE_TTL_MS);
    prices.now = NOW + PRICE_TTL_MS + 1;
    upstream.prices.set(SRC_BTC, { unitPrice: 61000, asOf: NOW });

    expect(await tokens.priceOf("tk_1")).toMatchObject({ unitPrice: 61000 });
    expect(upstream.calls).toEqual([`fetchPrices:${SRC_BTC}`]);
    expect(prices.current.get("tk_1")?.price.unitPrice).toBe(61000); // 写回了
  });

  it("上游还没认出的币取不了价 —— 不问上游,把旧值原样给出去", async () => {
    const { prices, upstream, tokens } = setup([info({ id: "tk_1", ref: null })]);
    await prices.put([{ tokenId: "tk_1", unitPrice: 42, asOf: 0 }], 0);
    expect(await tokens.priceOf("tk_1")).toMatchObject({ unitPrice: 42, stale: true });
    expect(upstream.calls).toEqual([]);
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
    const { prices, upstream, tokens } = setup([
      info({ id: "fresh" }),
      info({ id: "stale", ref: "src/ethereum" }),
      info({ id: "nopricexyz", ref: "src/tether" }),
      info({ id: "unknown", ref: null }), // 上游没认出 → 跳过
    ]);
    await prices.put([{ tokenId: "fresh", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
    await prices.put([{ tokenId: "stale", unitPrice: 1, asOf: 0 }], 0);
    upstream.prices.set("src/ethereum", { unitPrice: 3000, asOf: NOW });
    upstream.prices.set("src/tether", { unitPrice: 1, asOf: NOW });

    expect(await tokens.refreshStalePrices(["fresh", "stale", "nopricexyz", "unknown"])).toBe(2);
    expect(upstream.calls).toEqual(["fetchPrices:src/ethereum,src/tether"]);
  });

  it("没有要刷的 → 零调用", async () => {
    const { prices, upstream, tokens } = setup([info({ id: "tk_1" })]);
    await prices.put([{ tokenId: "tk_1", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
    expect(await tokens.refreshStalePrices(["tk_1"])).toBe(0);
    expect(await tokens.refreshStalePrices([])).toBe(0);
    expect(upstream.calls).toEqual([]);
  });
});

describe("边角", () => {
  it("上游回了个映射不到 token 的 ref → 跳过,不写野行", async () => {
    const { prices, upstream, tokens } = setup([info({ id: "tk_1" })]);
    // 上游多回了一条我们没问的(或已被合并掉的)ref。
    upstream.prices.set(SRC_BTC, { unitPrice: 60000, asOf: NOW });
    upstream.prices.set("src/stranger", { unitPrice: 1, asOf: NOW });

    expect(await tokens.refreshStalePrices(["tk_1"])).toBe(1);
    expect([...prices.current.keys()]).toEqual(["tk_1"]);
  });

  it("有价但 info 行没了(合并删过)→ 富化不出这一行", async () => {
    const { prices, tokens } = setup([info({ id: "tk_1" })]);
    await prices.put([{ tokenId: "tk_gone", unitPrice: 1, asOf: NOW }], PRICE_TTL_MS);
    const got = await tokens.enrich(["tk_1", "tk_gone"]);
    expect([...got.keys()]).toEqual(["tk_1"]);
  });
});

describe("历史日价(按 token_id)", () => {
  const day = (offset: number) => (TODAY + offset) * MS_PER_DAY;

  it("范围查:缓存命中的过去日直接用,缺的一次回源补齐并落缓存", async () => {
    const { prices, upstream, tokens } = setup([info({ id: "tk_1" })]);
    await prices.putDaily("tk_1", [{ dayBucket: TODAY - 3, unitPrice: 100 }]);
    upstream.series = [
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
    const { prices, upstream, tokens } = setup([info({ id: "tk_1" })]);
    await prices.putDaily("tk_1", [
      { dayBucket: TODAY - 2, unitPrice: 1 },
      { dayBucket: TODAY - 1, unitPrice: 2 },
    ]);
    expect(await tokens.priceSeries("tk_1", day(-2), day(-1))).toHaveLength(2);
    expect(upstream.calls).toEqual([]);
  });

  it("今日桶恒现取、不落缓存(它还会变)", async () => {
    const { prices, upstream, tokens } = setup([info({ id: "tk_1" })]);
    upstream.series = [{ atMs: NOW, unitPrice: 999 }];

    expect(await tokens.priceSeries("tk_1", day(0), NOW)).toEqual([
      { atMs: day(0), unitPrice: 999 },
    ]);
    expect(await prices.getDaily("tk_1", [TODAY])).toEqual(new Map());
    await tokens.priceSeries("tk_1", day(0), NOW);
    expect(upstream.calls).toHaveLength(2); // 第二次照样回源
  });

  it("上游失败 → 退回仅缓存,不抛", async () => {
    const { prices, upstream, tokens } = setup([info({ id: "tk_1" })]);
    await prices.putDaily("tk_1", [{ dayBucket: TODAY - 2, unitPrice: 7 }]);
    upstream.fetchPriceSeries = async () => {
      throw new Error("429");
    };
    expect(await tokens.priceSeries("tk_1", day(-2), day(-1))).toEqual([
      { atMs: day(-2), unitPrice: 7 },
    ]);
  });

  it("上游没认出的币 / 反向区间 → 空,不碰上游", async () => {
    const { upstream, tokens } = setup([info({ id: "unknown", ref: null }), info({ id: "tk_1" })]);
    expect(await tokens.priceSeries("unknown", day(-2), day(-1))).toEqual([]);
    expect(await tokens.priceSeries("tk_1", day(-1), day(-2))).toEqual([]);
    expect(upstream.calls).toEqual([]);
  });

  it("priceAt 取该 UTC 日桶的价;那天没数据 → undefined", async () => {
    const { prices, tokens } = setup([info({ id: "tk_1" })]);
    await prices.putDaily("tk_1", [{ dayBucket: TODAY - 5, unitPrice: 42 }]);
    expect(await tokens.priceAt("tk_1", day(-5) + 3_600_000)).toBe(42);
    expect(await tokens.priceAt("tk_1", day(-6))).toBeUndefined();
  });

  // 桶是 epoch 起算的整日,与月/年边界无关 —— 跨月那一天不该有任何特殊行为。
  // (日历月边界曾经是这类实现的常见错处:按 `getMonth()` 分组会在月初错一格。)
  it("priceAt 跨月/跨年的那一天照常取,桶按 epoch 整日切", async () => {
    const { prices, tokens } = setup([info({ id: "tk_1" })]);
    // 2023-12-31T23:00Z 与 2024-01-01T01:00Z —— 相邻两日,跨年。
    const lastDayOf2023 = Date.UTC(2023, 11, 31, 23, 0, 0);
    const firstDayOf2024 = Date.UTC(2024, 0, 1, 1, 0, 0);
    await prices.putDaily("tk_1", [
      { dayBucket: dayBucketOf(lastDayOf2023), unitPrice: 100 },
      { dayBucket: dayBucketOf(firstDayOf2024), unitPrice: 200 },
    ]);

    expect(await tokens.priceAt("tk_1", lastDayOf2023)).toBe(100);
    expect(await tokens.priceAt("tk_1", firstDayOf2024)).toBe(200);
    // 两个桶号确实相邻,没有因为跨年多出或少掉一格。
    expect(dayBucketOf(firstDayOf2024) - dayBucketOf(lastDayOf2023)).toBe(1);
  });

  it("priceAt 取的是**当日**的桶,不会把前一日的价当今天的", async () => {
    const { prices, tokens } = setup([info({ id: "tk_1" })]);
    await prices.putDaily("tk_1", [{ dayBucket: TODAY - 3, unitPrice: 7 }]);
    // 当日零点整(桶起点)也算当日。
    expect(await tokens.priceAt("tk_1", day(-3))).toBe(7);
    // 次日零点 → 已是下一个桶,当日无数据。
    expect(await tokens.priceAt("tk_1", day(-2))).toBeUndefined();
  });
});

describe("橱窗与候选", () => {
  it("排行榜走 warm(经 SWR 预热一次);候选与它同一份 rows", async () => {
    const { upstream, cache, tokens } = setup();
    upstream.markets = [
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
    expect(upstream.calls).toEqual(["fetchMarkets:1000"]);
    // 第二次从 blob 出,不再预热;候选也从同一份出 → 缓存里始终只有一个键。
    expect(await tokens.candidates.bySymbol("USDT")).toEqual([
      { ref: "src/tether", marketCapRank: 3 },
    ]);
    expect(upstream.calls).toHaveLength(1);
    expect([...cache.entries.keys()]).toEqual(["warm"]);
  });

  it("要的比有的多 → 给全部,不补空位", async () => {
    const { upstream, tokens } = setup();
    upstream.markets = [
      {
        ref: SRC_BTC,
        symbol: "BTC",
        name: "Bitcoin",
        price: { unitPrice: 60000, marketCapRank: 1, asOf: NOW },
      },
    ];
    const got = await tokens.topTokens(50);
    expect(got.map((t) => t.ref)).toEqual([SRC_BTC]);
    expect(got.every((t) => t !== undefined)).toBe(true);
  });

  it("预热失败不抛,返回空让调用方降级", async () => {
    const { upstream, tokens } = setup();
    upstream.fetchMarkets = async () => {
      throw new Error("429");
    };
    expect(await tokens.topTokens(10)).toEqual([]);
  });

  it("搜索恒回源(结果与用户无关)", async () => {
    const { upstream, tokens } = setup();
    upstream.searchResults = [{ ref: SRC_BTC, symbol: "BTC", name: "Bitcoin" }];
    expect(await tokens.search("bit")).toHaveLength(1);
    expect(upstream.calls).toEqual(["searchTokens:bit"]);
  });
});

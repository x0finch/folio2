import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { FxHistory, MS_PER_DAY } from "../src";
import { deriveFiatDaily } from "../src/fx-history";
import { harness, now0, upstreamDown } from "./fakes";

// 法币的**历史**日汇率(ADR 0026 / #274)—— 与现汇率(`FxRateResolver`)是两个服务。
//
// 这一组一个 `CacheStore` 都不碰(历史那半落 `token_daily_prices`,不进 user_cache)。

const setup = () => harness();
const withHistory = <A, E>(f: (h: FxHistory) => Effect.Effect<A, E>) =>
  Effect.flatMap(FxHistory, f);

// SWR 照 priceSeries:缓存命中直用 / 缺的从 BTC 反算并落库 / 今日现取 / 上游挂了降级不抛。
const NOW = now0;
const TODAY = Math.floor(NOW / MS_PER_DAY);
const day = (offset: number): number => (TODAY + offset) * MS_PER_DAY;
const FIAT_EUR = "fiat/issued:EUR";
// 两个 fake 默认 id 都是 "src" → btcRef 与代币 upstream 的 ref 命名空间对齐(反算腿走它取数)。
const BTC_REF = "src/issued:bitcoin";
// 代币 upstream 记的取数调用形:`fetchPriceSeries:<ref>:<VS 大写>`(见 fakeUpstream)。
const legCall = (vs: string) => `fetchPriceSeries:${BTC_REF}:${vs}`;

// 一条 BTC 腿的历史点(atMs 落在日桶起点 → 与请求区间边界对齐)。
const btcLeg = (perDay: Record<number, number>) =>
  Object.entries(perDay).map(([b, unitPrice]) => ({ atMs: Number(b) * MS_PER_DAY, unitPrice }));

describe("反算(纯)—— deriveFiatDaily", () => {
  it("usd_per_unit = BTC美元 ÷ BTC该币,逐日", () => {
    const usd = new Map([
      [TODAY - 2, 120000],
      [TODAY - 1, 100000],
    ]);
    const eur = new Map([
      [TODAY - 2, 100000],
      [TODAY - 1, 100000],
    ]);
    expect(deriveFiatDaily(usd, eur, [TODAY - 2, TODAY - 1])).toEqual(
      new Map([
        [TODAY - 2, 1.2],
        [TODAY - 1, 1],
      ]),
    );
  });

  it("缺任一腿、或 BTC该币 ≤ 0 的日跳过(不出乱数)", () => {
    const usd = new Map([
      [TODAY - 2, 120000],
      [TODAY - 1, 100000],
      [TODAY, 100000],
    ]);
    const eur = new Map([
      [TODAY - 2, 0], // 除零 → 跳过
      [TODAY - 1, 100000],
      // TODAY 缺该币腿 → 跳过
    ]);
    expect(deriveFiatDaily(usd, eur, [TODAY - 2, TODAY - 1, TODAY])).toEqual(
      new Map([[TODAY - 1, 1]]),
    );
  });
});

describe("rateSeries —— 历史日汇率", () => {
  it("USD 恒 1:逐日给 1,一次都不出网、不碰表", async () => {
    const h = setup();
    expect(await h.run(withHistory((fx) => fx.rateSeries("USD", day(-2), day(0))))).toEqual([
      { atMs: day(-2), unitPrice: 1 },
      { atMs: day(-1), unitPrice: 1 },
      { atMs: day(0), unitPrice: 1 },
    ]);
    expect(h.upstream.calls).toEqual([]);
    expect(h.prices.dailyByRef.size).toBe(0);
  });

  it("命中缓存的过去日直接用 —— 不反算、不出网", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxHistory;
        yield* h.prices.putDailyByRef(FIAT_EUR, [
          { dayBucket: TODAY - 2, unitPrice: 1.2 },
          { dayBucket: TODAY - 1, unitPrice: 1.1 },
        ]);
        expect(yield* fx.rateSeries("EUR", day(-2), day(-1))).toEqual([
          { atMs: day(-2), unitPrice: 1.2 },
          { atMs: day(-1), unitPrice: 1.1 },
        ]);
        expect(h.upstream.calls).toEqual([]); // 全缓存命中,零腿
      }),
    );
  });

  it("缺的过去日:从 BTC 两腿反算,并永久落 token_daily_prices", async () => {
    const h = setup();
    // 两条腿都从代币 upstream 的 fetchPriceSeries 取(vsCurrency 分 USD / EUR)。
    h.upstream.seriesByVs.set("USD", btcLeg({ [TODAY - 2]: 120000, [TODAY - 1]: 100000 }));
    h.upstream.seriesByVs.set("EUR", btcLeg({ [TODAY - 2]: 100000, [TODAY - 1]: 100000 }));

    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxHistory;
        expect(yield* fx.rateSeries("EUR", day(-2), day(-1))).toEqual([
          { atMs: day(-2), unitPrice: 1.2 },
          { atMs: day(-1), unitPrice: 1 },
        ]);
        // 过去日不可变 → 落库,下次直接命中。
        expect(yield* h.prices.getDailyByRef(FIAT_EUR, [TODAY - 2, TODAY - 1])).toEqual(
          new Map([
            [TODAY - 2, 1.2],
            [TODAY - 1, 1],
          ]),
        );
      }),
    );
  });

  it("BTC 美元腿优先读现有缓存 —— 有就不重取,只取该币腿", async () => {
    const h = setup();
    h.upstream.seriesByVs.set("EUR", btcLeg({ [TODAY - 2]: 100000, [TODAY - 1]: 100000 }));
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxHistory;
        // BTC 美元历史已在全局表(BTC 持有者暖过 / 上一轮落的)。
        yield* h.prices.putDailyByRef(BTC_REF, [
          { dayBucket: TODAY - 2, unitPrice: 120000 },
          { dayBucket: TODAY - 1, unitPrice: 100000 },
        ]);
        yield* fx.rateSeries("EUR", day(-2), day(-1));
        expect(h.upstream.calls).toEqual([legCall("EUR")]); // 美元腿命中缓存不出网
      }),
    );
  });

  it("今日桶恒现取、不落库(可变)", async () => {
    const h = setup();
    h.upstream.seriesByVs.set("USD", btcLeg({ [TODAY]: 100000 }));
    h.upstream.seriesByVs.set("EUR", btcLeg({ [TODAY]: 100000 }));

    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxHistory;
        expect(yield* fx.rateSeries("EUR", day(0), day(0))).toEqual([
          { atMs: day(0), unitPrice: 1 },
        ]);
        // 今日不落 —— 明天再看这一天已是过去日、会重取一次定值。
        expect(yield* h.prices.getDailyByRef(FIAT_EUR, [TODAY])).toEqual(new Map());
      }),
    );
  });

  it("上游挂了 → 降级到仅缓存,不抛", async () => {
    const h = setup();
    h.upstream.fail = upstreamDown();
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxHistory;
        yield* h.prices.putDailyByRef(FIAT_EUR, [{ dayBucket: TODAY - 2, unitPrice: 1.15 }]);
        // 请求 [-2, -1]:-2 命中缓存、-1 缺且反算失败 → 只回 -2,不抛。
        expect(yield* fx.rateSeries("EUR", day(-2), day(-1))).toEqual([
          { atMs: day(-2), unitPrice: 1.15 },
        ]);
      }),
    );
    expect(h.logs.some((l) => l.annotations.at === "fxHistory.rateSeries")).toBe(true);
  });

  it("from > to → 空", async () => {
    const h = setup();
    expect(await h.run(withHistory((fx) => fx.rateSeries("EUR", day(-1), day(-2))))).toEqual([]);
  });
});

import { Duration, Effect, Option, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import {
  dayBucketOf,
  FX_TTL_MS,
  FxRateResolver,
  MS_PER_DAY,
  PRICE_TTL_MS,
  SUPPORTED_CURRENCIES,
} from "../src";
import { deriveFiatDaily } from "../src/fx";
import { harness, now0, upstreamDown } from "./fakes";

// 汇率服务:**读软过期、写按 TTL**。两个动词判据不同,下面每一条都在钉这件事。

const setup = (rates: Record<string, number> = {}) => harness({ rates });
const withFx = <A, E>(f: (fx: FxRateResolver) => Effect.Effect<A, E>) =>
  Effect.flatMap(FxRateResolver, f);

describe("resolve —— 读", () => {
  it("USD 恒 1,而且不查缓存", async () => {
    const h = setup();
    expect(await h.run(withFx((fx) => fx.resolve("USD")))).toEqual(Option.some(1));
    expect(h.cache.entries.size).toBe(0); // 一次都没碰缓存
  });

  it("命中就给;**过期了也给** —— 汇率旧十分钟不如没有汇率糟", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* fx.warm(["EUR"]);
        expect(yield* fx.resolve("EUR")).toEqual(Option.some(1.09));

        yield* TestClock.adjust(Duration.millis(FX_TTL_MS * 2)); // 推过 TTL:条目变 stale
        expect(yield* fx.resolve("EUR")).toEqual(Option.some(1.09));
      }),
    );
  });

  it("缓存里没有 → none(调用方回退 USD)", async () => {
    const h = setup();
    expect(await h.run(withFx((fx) => fx.resolve("JPY")))).toEqual(Option.none());
  });

  it("键归一:大小写与空格不影响读到同一条", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* fx.warm(["EUR"]);
        expect(yield* fx.resolve("eur")).toEqual(Option.some(1.09));
        expect(yield* fx.resolve(" Eur ")).toEqual(Option.some(1.09));
      }),
    );
  });

  it("USD 的短路也归一 —— 小写 usd 同样恒 1,不掉进缓存查询", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        expect(yield* fx.resolve("usd")).toEqual(Option.some(1));
        expect(yield* fx.resolve(" Usd ")).toEqual(Option.some(1));
      }),
    );
    expect(h.cache.entries.size).toBe(0);
  });
});

describe("warm —— 写", () => {
  it("缺失 → 拉一次并写回;全新鲜 → 零请求", async () => {
    const h = setup({ USD: 1, EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* fx.warm(["USD", "EUR"]);
        expect(h.fxUpstream.fetches).toBe(1);
        expect(yield* fx.resolve("EUR")).toEqual(Option.some(1.09));

        yield* fx.warm(["USD", "EUR"]);
        expect(h.fxUpstream.fetches).toBe(1); // 都新鲜,不再出网
      }),
    );
  });

  it("过期 → 再拉一次", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* fx.warm(["EUR"]);
        yield* TestClock.adjust(Duration.millis(FX_TTL_MS + 1));
        yield* fx.warm(["EUR"]);
        expect(h.fxUpstream.fetches).toBe(2);
      }),
    );
  });

  it("只要 USD → 无目标,一次都不出网", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(withFx((fx) => fx.warm(["USD"])));
    expect(h.fxUpstream.fetches).toBe(0);
  });

  it("USD 不进新鲜度判断 —— 否则「全都新鲜」永远判不成立", async () => {
    const h = setup({ USD: 1, EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* fx.warm(["USD", "EUR"]);
        yield* fx.warm(["USD", "EUR"]);
        yield* fx.warm(["USD", "EUR"]);
      }),
    );
    expect(h.fxUpstream.fetches).toBe(1);
    expect(h.cache.entries.has("fx:USD")).toBe(false); // USD 压根不落缓存
  });

  it("一次响应里的**其余币种一并写上** —— 反正都在同一份里,下次别人切过去就是热的", async () => {
    const h = setup({ USD: 1, EUR: 1.09, JPY: 0.0067 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* fx.warm(["EUR"]); // 只点名要 EUR
        expect(yield* fx.resolve("JPY")).toEqual(Option.some(0.0067));
      }),
    );
    expect(h.fxUpstream.fetches).toBe(1);
  });

  it("**一个批次写回** —— 十来个币种一次 D1,不是十来次往返", async () => {
    const h = setup(Object.fromEntries(SUPPORTED_CURRENCIES.map((c, i) => [c.code, i + 1])));
    await h.run(withFx((fx) => fx.warm()));
    expect(h.cache.writes).toBe(1);
  });

  it("新鲜度判断也是**一次批量读**,不是逐币种点查", async () => {
    const h = setup({ EUR: 1.09, JPY: 0.0067 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* fx.warm(["EUR", "JPY"]);
        const before = h.cache.reads;

        yield* fx.warm(["EUR", "JPY"]); // 都新鲜 → 只为判断读了一次
        expect(h.cache.reads - before).toBe(1);
      }),
    );
  });

  it("缺省预热全部支持币种", async () => {
    const h = setup(Object.fromEntries(SUPPORTED_CURRENCIES.map((c, i) => [c.code, i + 1])));
    await h.run(withFx((fx) => fx.warm()));
    // 除 USD 之外全都写上了。
    expect(h.cache.entries.size).toBe(SUPPORTED_CURRENCIES.length - 1);
  });

  it("上游不认识的币种不出现 → 那一条仍取不到,不写脏值", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* fx.warm(["EUR", "KRW"]);
        expect(yield* fx.resolve("KRW")).toEqual(Option.none());
      }),
    );
  });

  it("小写币种也归一 —— 否则 usd 既不短路又永不落缓存,每次预热白拉一趟", async () => {
    const h = setup({ USD: 1, EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* fx.warm(["usd"]); // 归一成 USD → 无目标
        expect(h.fxUpstream.fetches).toBe(0);

        yield* fx.warm(["eur"]);
        yield* fx.warm(["EUR"]); // 上一次写的就是 fx:EUR → 这次判新鲜
        expect(h.fxUpstream.fetches).toBe(1);
      }),
    );
  });

  // 迁移前这里**往上抛**,理由是「调用方自己决定怎么降级」—— 但两个调用方(同步后的预热、
  // 手记表单的按需预热)都只是把它吞掉。现在与其余降级点同一个口径:记一行、什么都不写。
  // 读那一侧本来就软过期,拿得到旧值就用旧值。
  it("上游挂了 → 记一行、不写、不抛;旧值照旧可读", async () => {
    const h = setup({ EUR: 1.09 });
    await h.run(withFx((fx) => fx.warm(["EUR"])));
    h.fxUpstream.fail = upstreamDown();

    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* TestClock.adjust(Duration.millis(FX_TTL_MS + 1));
        yield* fx.warm(["EUR"]);
        expect(yield* fx.resolve("EUR")).toEqual(Option.some(1.09)); // 旧值还在
      }),
    );
    expect(h.logs.some((l) => l.annotations.at === "fx.warm")).toBe(true);
  });
});

// 这个 TTL 是当初唯一改了数值的东西(30min → 6h),而 30min 那个数是**币价**的 TTL。
// 汇率一天动千分之几 —— 钉住「它属于慢变那一档」,别哪天又被抄回价格那一档。
describe("TTL 的量级", () => {
  it("汇率的 TTL 数量级上属于慢变数据,不与长尾币价同档", () => {
    expect(FX_TTL_MS).toBeGreaterThan(PRICE_TTL_MS * 4);
  });
});

// —— 历史日汇率(ADR 0026 / #274)——
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

describe("fiatRateSeries —— 历史日汇率", () => {
  it("USD 恒 1:逐日给 1,一次都不出网、不碰表", async () => {
    const h = setup();
    expect(await h.run(withFx((fx) => fx.fiatRateSeries("USD", day(-2), day(0))))).toEqual([
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
        const fx = yield* FxRateResolver;
        yield* h.prices.putDailyByRef(FIAT_EUR, [
          { dayBucket: TODAY - 2, unitPrice: 1.2 },
          { dayBucket: TODAY - 1, unitPrice: 1.1 },
        ]);
        expect(yield* fx.fiatRateSeries("EUR", day(-2), day(-1))).toEqual([
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
        const fx = yield* FxRateResolver;
        expect(yield* fx.fiatRateSeries("EUR", day(-2), day(-1))).toEqual([
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
        const fx = yield* FxRateResolver;
        // BTC 美元历史已在全局表(BTC 持有者暖过 / 上一轮落的)。
        yield* h.prices.putDailyByRef(BTC_REF, [
          { dayBucket: TODAY - 2, unitPrice: 120000 },
          { dayBucket: TODAY - 1, unitPrice: 100000 },
        ]);
        yield* fx.fiatRateSeries("EUR", day(-2), day(-1));
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
        const fx = yield* FxRateResolver;
        expect(yield* fx.fiatRateSeries("EUR", day(0), day(0))).toEqual([
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
        const fx = yield* FxRateResolver;
        yield* h.prices.putDailyByRef(FIAT_EUR, [{ dayBucket: TODAY - 2, unitPrice: 1.15 }]);
        // 请求 [-2, -1]:-2 命中缓存、-1 缺且反算失败 → 只回 -2,不抛。
        expect(yield* fx.fiatRateSeries("EUR", day(-2), day(-1))).toEqual([
          { atMs: day(-2), unitPrice: 1.15 },
        ]);
      }),
    );
    expect(h.logs.some((l) => l.annotations.at === "fx.fiatRateSeries")).toBe(true);
  });

  it("from > to → 空", async () => {
    const h = setup();
    expect(await h.run(withFx((fx) => fx.fiatRateSeries("EUR", day(-1), day(-2))))).toEqual([]);
  });
});

describe("fiatRateAt —— 某日汇率", () => {
  it("取该 atMs 所属 UTC 日桶的汇率", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxRateResolver;
        yield* h.prices.putDailyByRef(FIAT_EUR, [
          { dayBucket: dayBucketOf(day(-1)), unitPrice: 1.07 },
        ]);
        expect(yield* fx.fiatRateAt("EUR", day(-1) + 5000)).toEqual(Option.some(1.07));
      }),
    );
  });

  it("该日无数据 → none", async () => {
    const h = setup();
    expect(await h.run(withFx((fx) => fx.fiatRateAt("EUR", day(-9))))).toEqual(Option.none());
  });
});

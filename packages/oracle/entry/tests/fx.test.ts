import { FX_TTL_MS, MS_PER_DAY, PRICE_TTL_MS, SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { Duration, Effect, Option, TestClock } from "effect";
import { describe, expect, it } from "vitest";
import { FxService } from "../src";
import { deriveFiatDaily, fxKey, readFx, writeFx } from "../src/services/fx";
import { harness, now0, upstreamDown } from "./fakes";

// 汇率服务的三个方法,两种判据:
//   `resolve` / `warm`  **现**汇率 —— 读软过期、写按 TTL(前两组)
//   `rateSeries`        **历史**日汇率 —— SWR + BTC 反算(后两组,ADR 0026 / #274)
//
// 两半合成一个服务(以前是 `FxRateResolver` / `FxHistory`,见 `../src/services/fx` 的开头),
// 但**持久化仍然是两处**,这一组的分组就是照着这件事切的:现汇率只碰 `user_cache`,
// 历史日汇率一个 `CacheStore` 都不碰(它落全局的 `token_daily_prices`)。

const setup = (rates: Record<string, number> = {}) => harness({ rates });
const withFx = <A, E>(f: (fx: FxService) => Effect.Effect<A, E>) => Effect.flatMap(FxService, f);

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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
        yield* fx.warm(["EUR", "KRW"]);
        expect(yield* fx.resolve("KRW")).toEqual(Option.none());
      }),
    );
  });

  it("小写币种也归一 —— 否则 usd 既不短路又永不落缓存,每次预热白拉一趟", async () => {
    const h = setup({ USD: 1, EUR: 1.09 });
    await h.run(
      Effect.gen(function* () {
        const fx = yield* FxService;
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
        const fx = yield* FxService;
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

// —— 缓存那一侧(键 / 形状 / 批量)——
// 这几条直接打 `../src/fx` 里的读写口,把假端口当参数传进去:它们的 `R` 是 `never`。
describe("缓存:键、形状、批量", () => {
  it("键是 `fx:<大写币种>`,归一在造键那一处", async () => {
    const h = setup();
    await h.run(writeFx(h.cache, [{ currency: " eur ", usdPerUnit: 1.08 }]));

    expect([...h.cache.entries.keys()]).toEqual(["fx:EUR"]);
    expect(fxKey(" eur ")).toBe("fx:EUR");
  });

  it("读回是数;miss → none", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        yield* writeFx(h.cache, [{ currency: "EUR", usdPerUnit: 1.08 }]);
        expect(yield* readFx(h.cache, "eur")).toEqual(Option.some(1.08));
        expect(yield* readFx(h.cache, "JPY")).toEqual(Option.none());
      }),
    );
  });

  it("批量写一个批次 —— 逐键往返会把 1 次 D1 变成 N 次", async () => {
    const h = setup();
    await h.run(
      writeFx(h.cache, [
        { currency: "EUR", usdPerUnit: 1.08 },
        { currency: "JPY", usdPerUnit: 0.0067 },
        { currency: "GBP", usdPerUnit: 1.27 },
      ]),
    );
    expect(h.cache.writes).toBe(1); // 三个币种,一个批次
  });

  // 缓存里躺着的可能是**上一个版本写的形状**(或者手动改过库)。走 Schema 解码,
  // 解不动就当没有 → 回源重写一份,自愈;`as number` 的话坏值会一路端上屏。
  it("不是数(旧形状 / 手改过库)→ 当没有,不把坏值端上屏", async () => {
    const h = setup();
    await h.run(
      Effect.gen(function* () {
        yield* h.cache.put(fxKey("EUR"), "1.08", FX_TTL_MS);
        expect(yield* readFx(h.cache, "EUR")).toEqual(Option.none());
      }),
    );
  });
});

// —— 历史日汇率(`rateSeries`)——
// SWR 照 priceSeries:缓存命中直用 / 缺的从 BTC 反算并落库 / 今日现取 / 上游挂了降级不抛。
// **这一段一个 `CacheStore` 都不碰** —— 它落 `token_daily_prices`,不进 user_cache。
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
    expect(await h.run(withFx((fx) => fx.rateSeries("USD", day(-2), day(0))))).toEqual([
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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
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
        const fx = yield* FxService;
        yield* h.prices.putDailyByRef(FIAT_EUR, [{ dayBucket: TODAY - 2, unitPrice: 1.15 }]);
        // 请求 [-2, -1]:-2 命中缓存、-1 缺且反算失败 → 只回 -2,不抛。
        expect(yield* fx.rateSeries("EUR", day(-2), day(-1))).toEqual([
          { atMs: day(-2), unitPrice: 1.15 },
        ]);
      }),
    );
    expect(h.logs.some((l) => l.annotations.at === "fx.rateSeries")).toBe(true);
  });

  it("from > to → 空", async () => {
    const h = setup();
    expect(await h.run(withFx((fx) => fx.rateSeries("EUR", day(-1), day(-2))))).toEqual([]);
  });
});

import type { UpstreamError } from "@folio/client-core";
import type { TokenPricePoint } from "@folio/oracle-basic";
import { dayBucketOf, FIAT_NAMER, MS_PER_DAY, SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { CacheStore, FxUpstream, TokenPriceStore, TokenUpstream } from "@folio/oracle-basic/ports";
import { tokenRef } from "@folio/oracle-ref";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { cacheKeys, readFx, readFxFreshness, writeFx } from "./cache";
import { degradeTo } from "./degrade";

// 展示币种的汇率服务。**读软过期、写按 TTL** —— 两个动词的判据不同,这是本文件的全部内容。
//
// `resolve`(读)不看过期:汇率旧十分钟不会让总资产错到影响决策,而「暂时没有汇率」会让整个
// 认证区拿不到数字。所以有多旧都给,新鲜度由 `warm` 负责往上追。
// `warm`(写)才看过期:任一目标币种缺失或过期 → 一次拉全 → 逐个写回。
export interface FxRateResolver {
  // 1 单位该币种值多少美元。USD 恒 1(不查缓存);缓存里没有 → `none`(调用方回退 USD)。
  resolve(currency: string): Effect.Effect<Option.Option<number>>;
  // 预热(同步之后 / 用户第一次切币种时)。缺省预热全部支持币种。
  warm(currencies?: readonly string[]): Effect.Effect<void>;

  // —— 历史日汇率(ADR 0026 / #274)——
  // 某法币在区间内逐日的 usd_per_unit,口径同 `resolve` 但按**当天**汇率。SWR 照 `priceSeries`:
  // 命中缓存的过去日直接用、缺的从 BTC 反算并永久落 `token_daily_prices`、今日桶恒现取;上游失败 →
  // 退回仅缓存。USD 恒 1(不出网)。缓存/派生对齐到 UTC 日桶(`atMs = 日桶 × 一日毫秒`)。
  fiatRateSeries(
    code: string,
    fromMs: number,
    toMs: number,
  ): Effect.Effect<readonly TokenPricePoint[]>;
  // 某时刻的历史汇率:atMs 所属 UTC 日桶的汇率;该日无数据 → `none`(调用方降级)。
  fiatRateAt(code: string, atMs: number): Effect.Effect<Option.Option<number>>;
}

export const FxRateResolver = Context.GenericTag<FxRateResolver>("oracle/FxRateResolver");

const ALL_CODES = SUPPORTED_CURRENCIES.map((c) => c.code);

// 逐日反算法币美元价(纯):usd_per_unit(code)@日 = BTC美元@日 ÷ BTC该币@日。缺任一腿、或
// BTC该币 ≤ 0(坏值 / 除零)的日**跳过**——宁可那天没历史价、走降级链,也不出一个乱数。导出供纯测。
export function deriveFiatDaily(
  btcUsdByDay: ReadonlyMap<number, number>,
  btcCodeByDay: ReadonlyMap<number, number>,
  buckets: readonly number[],
): Map<number, number> {
  const out = new Map<number, number>();
  for (const b of buckets) {
    const usd = btcUsdByDay.get(b);
    const inCode = btcCodeByDay.get(b);
    if (usd != null && inCode != null && inCode > 0) out.set(b, usd / inCode);
  }
  return out;
}

// 币种 code 的归一口径,与造缓存键那一处(`cacheKeys.fx`)必须一致。
// 不归一的话「是不是 USD」这个判断会漏掉 `usd`:它既不短路成 1、又永远不会被写进缓存
// (写的时候按大写过滤掉了),于是每次预热都白拉一趟上游。
const norm = (code: string): string => code.trim().toUpperCase();

// 历史那半的两个依赖(价 store + 取数口)**不再是可选字段**。迁移前它们是
// `prices?` / `priceUpstream?`,而生产装配一直两个都给 —— 只有测试构造过「现价-only」的门面。
// 判据是 CODING.md 那条:只有测试会传(或不传)的字段,就不该是字段。
const make = Effect.gen(function* () {
  const cache = yield* CacheStore;
  const upstream = yield* FxUpstream;
  // 历史日汇率读写 `token_daily_prices`(按 ref 直存,见 `getDailyByRef`)。
  const prices = yield* TokenPriceStore;
  // BTC 反算两条腿走 `fetchPriceSeries(btcRef, …, vsCurrency)`(ADR 0026:复用现成取数口,
  // 不给 `FxUpstream` 加取数方法)。BTC 反算是全仓价格骨架的一部分,所以历史那半天然搭在代币上游上。
  const priceUpstream = yield* TokenUpstream;

  // BTC 美元历史腿:优先读 `token_daily_prices` 的 `coingecko/issued:bitcoin`(BTC 持有者 / 上一轮
  // 已暖的直接命中),缺的过去日拉一次并落库(顺带暖给 BTC 持有者),今日桶现取不落。返回全桶的
  // Map(命中什么给什么)。ADR 0026 的「BTC 美元腿优先读缓存、不重取」就在这里。
  const btcUsdDaily = (
    buckets: readonly number[],
    todayB: number,
  ): Effect.Effect<Map<number, number>, UpstreamError> =>
    Effect.gen(function* () {
      const cached = yield* prices.getDailyByRef(upstream.btcRef, buckets);
      const missingPast = buckets.filter((b) => b < todayB && !cached.has(b));
      const needsToday = buckets.includes(todayB);
      if (missingPast.length === 0 && !needsToday) return cached;

      const fromMs = Math.min(...buckets) * MS_PER_DAY;
      const toMs = Math.max(...buckets) * MS_PER_DAY + (MS_PER_DAY - 1);
      const fetched = new Map<number, number>();
      for (const pt of yield* priceUpstream.fetchPriceSeries(upstream.btcRef, fromMs, toMs)) {
        if (pt.unitPrice > 0) fetched.set(dayBucketOf(pt.atMs), pt.unitPrice); // 升序 → 当日最后一点胜出
      }
      const toPersist = [...fetched.entries()]
        .filter(([b]) => b < todayB && !cached.has(b))
        .map(([dayBucket, unitPrice]) => ({ dayBucket, unitPrice }));
      if (toPersist.length > 0) yield* prices.putDailyByRef(upstream.btcRef, toPersist);

      const out = new Map(cached);
      for (const [b, v] of fetched) if (!out.has(b)) out.set(b, v);
      return out;
    });

  const fiatRateSeries = (
    code: string,
    fromMs: number,
    toMs: number,
  ): Effect.Effect<readonly TokenPricePoint[]> =>
    Effect.gen(function* () {
      if (fromMs > toMs) return [];
      const CODE = norm(code);
      const fromB = dayBucketOf(fromMs);
      const toB = dayBucketOf(toMs);
      const buckets: number[] = [];
      for (let b = fromB; b <= toB; b++) buckets.push(b);

      // USD 恒 1 —— 不出网、不查表、不反算它自己。
      if (CODE === "USD") return buckets.map((b) => ({ atMs: b * MS_PER_DAY, unitPrice: 1 }));

      const fiatRef = tokenRef.issued(FIAT_NAMER, CODE);
      const todayB = dayBucketOf(yield* Clock.currentTimeMillis);
      const cached = yield* prices.getDailyByRef(fiatRef, buckets);
      const missingPast = buckets.filter((b) => b < todayB && !cached.has(b));
      const needsToday = toB >= todayB;

      const derived = new Map<number, number>();
      if (missingPast.length > 0 || needsToday) {
        // 两条腿都走 fetchPriceSeries(btcRef):BTC 美元(优先缓存)+ BTC/该币(vsCurrency=CODE,
        // 现取不落)。反算 = 前者 ÷ 后者。任一腿挂 → 整块降级到仅缓存(记一行)。
        const legs = Effect.gen(function* () {
          const btcCode = new Map<number, number>();
          const series = yield* priceUpstream.fetchPriceSeries(upstream.btcRef, fromMs, toMs, CODE);
          for (const pt of series) {
            if (pt.unitPrice > 0) btcCode.set(dayBucketOf(pt.atMs), pt.unitPrice);
          }
          const btcUsd = yield* btcUsdDaily(buckets, todayB);
          return deriveFiatDaily(btcUsd, btcCode, buckets);
        });

        for (const [b, v] of yield* legs.pipe(
          degradeTo("fx.fiatRateSeries", new Map<number, number>()),
        )) {
          derived.set(b, v);
        }

        const toPersist = [...derived.entries()]
          .filter(([b]) => b < todayB && !cached.has(b)) // 只落不可变的过去日
          .map(([dayBucket, unitPrice]) => ({ dayBucket, unitPrice }));
        if (toPersist.length > 0) yield* prices.putDailyByRef(fiatRef, toPersist);
      }

      const out: TokenPricePoint[] = [];
      for (const b of buckets) {
        const rate = cached.get(b) ?? derived.get(b);
        if (typeof rate === "number") out.push({ atMs: b * MS_PER_DAY, unitPrice: rate });
      }
      return out;
    });

  const resolver: FxRateResolver = {
    fiatRateSeries,

    fiatRateAt: (code, atMs) =>
      Effect.map(
        Effect.suspend(() => fiatRateSeries(code, dayBucketOf(atMs) * MS_PER_DAY, atMs)),
        (series) => Option.fromNullable(series.at(-1)?.unitPrice),
      ),

    resolve: (currency) =>
      norm(currency) === "USD" ? Effect.succeed(Option.some(1)) : readFx(cache, currency),

    warm: (currencies = ALL_CODES) =>
      Effect.gen(function* () {
        // USD 不进目标:它恒为 1、不存缓存,算进去会让「全都新鲜」永远判不成立。
        const targets = [...new Set(currencies.map(norm))].filter((c) => c !== "USD");
        if (targets.length === 0) return;

        // 一次批量读:目标全都在且新鲜 → 什么都不做。
        const hits = yield* readFxFreshness(cache, targets);
        if (targets.every((c) => hits.get(cacheKeys.fx(c))?.stale === false)) return;

        // 一次拉全 → **一个批次**把其余支持币种也写上(反正都在同一份响应里),
        // 下次别人切过去就是热的。逐个写会把一次 D1 批次变成十来次往返。
        // 上游挂了 → 记一行、什么都不写(读那一侧软过期,拿得到旧值就用旧的)。
        const fresh = yield* upstream
          .fetchRates()
          .pipe(
            Effect.map(Option.some<ReadonlyMap<string, number>>),
            degradeTo("fx.warm", Option.none<ReadonlyMap<string, number>>()),
          );
        if (Option.isNone(fresh)) return;
        yield* writeFx(
          cache,
          [...fresh.value]
            .filter(([code]) => norm(code) !== "USD")
            .map(([currency, usdPerUnit]) => ({ currency, usdPerUnit })),
        );
      }),
  };

  return resolver;
});

export const fxRateResolverLayer: Layer.Layer<
  FxRateResolver,
  never,
  CacheStore | FxUpstream | TokenPriceStore | TokenUpstream
> = Layer.effect(FxRateResolver, make);

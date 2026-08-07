import type { UpstreamError } from "@folio/client-core";
import type { TokenPricePoint } from "@folio/oracle-basic";
import { dayBucketOf, FIAT_NAMER, MS_PER_DAY } from "@folio/oracle-basic";
import { FxUpstream, TokenPriceStore, TokenUpstream } from "@folio/oracle-basic/ports";
import { tokenRef } from "@folio/oracle-ref";
import { Clock, Context, Effect, Layer } from "effect";
import { degradeTo } from "./degrade";

// 历史日汇率(ADR 0026 / #274)。**与「现在的汇率」(`FxRateResolver`)是两件事**,所以是两个服务:
// 两半不共用缓存键、不共用上游、不共用一行逻辑,而合住一个文件时 `FxRateResolver` 的 `R` 被撑到
// 四个服务(其中两个纯粹是历史这半拖进来的)—— `R` 本来是最好的自文档,那时它在撒谎。
//
// 这半**不碰 `CacheStore`**:它的持久化落 `token_daily_prices`(全局键、过去日不可变),
// 不进 per-user 的 `user_cache`。从 `FxUpstream` 只要 `btcRef` 一个字段 —— 那是 fx 与代币两个
// 世界的桥(BTC 反算的基),留在 `FxUpstream` 上是对的,不为了消掉这条依赖去挪它。
//
// **`fx` 与 `fiat` 在本仓是两个词,不是一件事的两种写法**,所以这个文件里两个都出现:
//   `fx`   汇率本身 —— `FxUpstream` / `FX_TTL_MS` / `fx:<币种>` 键 / 本服务与 `FxRateResolver`
//   `fiat` 把法币当成一种「币」的那套 —— `FIAT_NAMER` / `fiat/issued:<CODE>` / `fiatSeed`
// 服务名按**它给什么**取(历史汇率 → `FxHistory`),存储那侧按**它存成什么**取(法币 token 行 →
// `FIAT_NAMER`)。这个文件叫过 `fiat-history.ts`,那是拿实现的词命名领域的东西,并排看就露馅。
export interface FxHistory {
  // 某法币在区间内逐日的 usd_per_unit,口径同 `FxRateResolver.resolve` 但按**当天**汇率。
  // SWR 照 `priceSeries`:命中缓存的过去日直接用、缺的从 BTC 反算并永久落 `token_daily_prices`、
  // 今日桶恒现取;上游失败 → 退回仅缓存。USD 恒 1(不出网)。
  // 缓存/派生对齐到 UTC 日桶(`atMs = 日桶 × 一日毫秒`)。
  rateSeries(code: string, fromMs: number, toMs: number): Effect.Effect<readonly TokenPricePoint[]>;
}

export const FxHistory = Context.GenericTag<FxHistory>("oracle/FxHistory");

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

// 币种 code 的归一口径,与 `FxRateResolver` 那边(以及造缓存键那一处)必须一致。
const norm = (code: string): string => code.trim().toUpperCase();

const make = Effect.gen(function* () {
  // 历史日汇率读写 `token_daily_prices`(按 ref 直存,见 `getDailyByRef`)。
  const prices = yield* TokenPriceStore;
  // BTC 反算两条腿走 `fetchPriceSeries(btcRef, …, vsCurrency)`(ADR 0026:复用现成取数口,
  // 不给 `FxUpstream` 加取数方法)。BTC 反算是全仓价格骨架的一部分,所以历史这半搭在代币上游上。
  const priceUpstream = yield* TokenUpstream;
  const { btcRef } = yield* FxUpstream;

  // BTC 美元历史腿:优先读 `token_daily_prices` 的 `coingecko/issued:bitcoin`(BTC 持有者 / 上一轮
  // 已暖的直接命中),缺的过去日拉一次并落库(顺带暖给 BTC 持有者),今日桶现取不落。返回全桶的
  // Map(命中什么给什么)。ADR 0026 的「BTC 美元腿优先读缓存、不重取」就在这里。
  const btcUsdDaily = (
    buckets: readonly number[],
    todayB: number,
  ): Effect.Effect<Map<number, number>, UpstreamError> =>
    Effect.gen(function* () {
      const cached = yield* prices.getDailyByRef(btcRef, buckets);
      const missingPast = buckets.filter((b) => b < todayB && !cached.has(b));
      const needsToday = buckets.includes(todayB);
      if (missingPast.length === 0 && !needsToday) return cached;

      const fromMs = Math.min(...buckets) * MS_PER_DAY;
      const toMs = Math.max(...buckets) * MS_PER_DAY + (MS_PER_DAY - 1);
      const fetched = new Map<number, number>();
      for (const pt of yield* priceUpstream.fetchPriceSeries(btcRef, fromMs, toMs)) {
        if (pt.unitPrice > 0) fetched.set(dayBucketOf(pt.atMs), pt.unitPrice); // 升序 → 当日最后一点胜出
      }
      const toPersist = [...fetched.entries()]
        .filter(([b]) => b < todayB && !cached.has(b))
        .map(([dayBucket, unitPrice]) => ({ dayBucket, unitPrice }));
      if (toPersist.length > 0) yield* prices.putDailyByRef(btcRef, toPersist);

      const out = new Map(cached);
      for (const [b, v] of fetched) if (!out.has(b)) out.set(b, v);
      return out;
    });

  const history: FxHistory = {
    rateSeries: (code, fromMs, toMs) =>
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
          // 两条腿都走 `fetchPriceSeries(btcRef)`:BTC 该币(vsCurrency=CODE,现取不落)+
          // BTC 美元(优先缓存)。反算 = 后者 ÷ 前者。
          // **两条腿并发** —— 它们互不依赖,而这条路是用户在等历史曲线(串起来白赔一次往返)。
          // 任一腿挂 → 整块降级到仅缓存(记一行)。
          const legs = Effect.gen(function* () {
            const [series, btcUsd] = yield* Effect.all(
              [
                priceUpstream.fetchPriceSeries(btcRef, fromMs, toMs, CODE),
                btcUsdDaily(buckets, todayB),
              ],
              { concurrency: 2 },
            );
            const btcCode = new Map<number, number>();
            for (const pt of series) {
              if (pt.unitPrice > 0) btcCode.set(dayBucketOf(pt.atMs), pt.unitPrice);
            }
            return deriveFiatDaily(btcUsd, btcCode, buckets);
          });

          for (const [b, v] of yield* legs.pipe(
            degradeTo("fxHistory.rateSeries", new Map<number, number>()),
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
      }),
  };

  return history;
});

export const fxHistoryLayer: Layer.Layer<
  FxHistory,
  never,
  TokenPriceStore | TokenUpstream | FxUpstream
> = Layer.effect(FxHistory, make);

import type { UpstreamError } from "@folio/client-core";
import type { CacheEntry, TokenPricePoint, TokenRef } from "@folio/oracle-basic";
import {
  dayBucketOf,
  FIAT_NAMER,
  FX_TTL_MS,
  MS_PER_DAY,
  SUPPORTED_CURRENCIES,
} from "@folio/oracle-basic";
import { CacheStore, FxUpstream, TokenPriceStore, TokenUpstream } from "@folio/oracle-basic/ports";
import { tokenRef } from "@folio/oracle-ref";
import { Clock, Effect, Option, Schema } from "effect";
import { degradeTo } from "./tokens/swr";

// 汇率这个领域的门面 —— **现在的汇率与历史的汇率在同一个服务上**。
//
// 曾经是两个(`FxRateResolver` / `FxHistory`),理由是「两半不共用缓存键、不共用上游、
// 不共用一行逻辑」。那是按**能力**切,不是按**领域**切:同样的话对 `TokenService` 全都成立
// (现价走价 store、历史价走 `token_daily_prices`、两条也不共用一行逻辑),而那边从来没人
// 提议拆。判据统一到 ADR 0012 的口径之后,这两半归位成一个服务的三个方法。
//
// 三个方法、两种判据:
//   `resolve`    读**现**汇率 —— 软过期,有多旧都给
//   `warm`       写**现**汇率 —— 按 TTL,缺或过期才拉
//   `rateSeries` 读**历史**日汇率 —— SWR:过去日落库不可变,今日桶恒现取
//
// `resolve` 不看过期:汇率旧十分钟不会让总资产错到影响决策,而「暂时没有汇率」会让整个
// 认证区拿不到数字。所以有多旧都给,新鲜度由 `warm` 负责往上追。
//
// **两半的持久化确实不同,合住之后更要写清楚**:现汇率住 per-user 的 `user_cache`
// (`fx:<币种>` 键,TTL 6h);历史日汇率落全局的 `token_daily_prices`(过去日不可变),
// **一个字都不写 user_cache**。所以本服务的 `R` 有四个端口,其中 `TokenPriceStore` /
// `TokenUpstream` 只被 `rateSeries` 用到。
//
// **`fx` 与 `fiat` 在本仓是两个词,不是一件事的两种写法**,所以这个文件里两个都出现:
//   `fx`   汇率本身 —— `FxUpstream` / `FX_TTL_MS` / `fx:<币种>` 键 / 本服务
//   `fiat` 把法币当成一种「币」的那套 —— `FIAT_NAMER` / `fiat/issued:<CODE>` / `fiatSeed`
// 服务名按**它给什么**取,存储那侧按**它存成什么**取(法币 token 行 → `FIAT_NAMER`)。
const ALL_CODES = SUPPORTED_CURRENCIES.map((c) => c.code);

// 币种 code 的归一口径。**造键、判「是不是 USD」、反查法币 ref 共用这一个函数** ——
// 两处分开写过一次,漏归一的话 `usd` 既不短路成 1、又永远不会被写进缓存(写的时候按大写
// 过滤掉了),于是每次预热都白拉一趟上游。合住这个文件之后它也只剩一份。
const norm = (code: string): string => code.trim().toUpperCase();

// —— 现汇率的缓存那一侧:键、形状、三个读写口 ——
// 汇率住 per-user 缓存表的 `fx:<币种>` 键上(另两种键见 warm.ts / platforms.ts)。
// **读写都走批量**:上游那个端点一把给十来个币种,逐键往返会把 1 次 D1 变成 N 次。
// TTL 6h —— 慢变,但不静态。

export const fxKey = (currency: string): string => `fx:${norm(currency)}`;

// 存的就是一个数。解不动(旧形状 / 手改过库)当 miss —— 回源重写一份,自愈,
// 而不是把坏值 `as number` 一路端到展示层。
const decodeNumber = Schema.decodeUnknownOption(Schema.Number);

export const readFx = (cache: CacheStore, currency: string): Effect.Effect<Option.Option<number>> =>
  Effect.map(cache.get(fxKey(currency)), (hit) =>
    Option.flatMap(hit, (entry) => decodeNumber(entry.value)),
  );

// 一批币种的新鲜度(预热用):miss 的键不出现,命中的带 stale。
const readFxFreshness = (
  cache: CacheStore,
  currencies: readonly string[],
): Effect.Effect<Map<string, CacheEntry>> => cache.getMany(currencies.map(fxKey));

// 一次批量写回。上游那个端点一把全给,所以这里恒是「十来个键一个批次」。
export const writeFx = (
  cache: CacheStore,
  rates: readonly { currency: string; usdPerUnit: number }[],
): Effect.Effect<void> =>
  cache.putMany(
    rates.map((r) => ({ key: fxKey(r.currency), value: r.usdPerUnit, ttlMs: FX_TTL_MS })),
  );

// BTC 美元历史腿:优先读 `token_daily_prices` 的 `coingecko/issued:bitcoin`(BTC 持有者 / 上一轮
// 已暖的直接命中),缺的过去日拉一次并落库(顺带暖给 BTC 持有者),今日桶现取不落。返回全桶的
// Map(命中什么给什么)。ADR 0026 的「BTC 美元腿优先读缓存、不重取」就在这里。
//
// **收已解析好的服务对象**(与本文件其余几个辅助件、以及 `./warm` 同款),所以它的 `R` 是
// `never`、能被直接喂假端口打 —— 那条「不重取」的规则因此有自己的用例,不必绕整条反算去数请求。
export const btcUsdDaily = (
  prices: TokenPriceStore,
  upstream: TokenUpstream,
  btcRef: TokenRef,
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
    for (const pt of yield* upstream.fetchPriceSeries(btcRef, fromMs, toMs)) {
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

// 服务的形状从下面这段 `effect` 的返回值推导,`.Default` 就是它的 layer —— 不再手写
// interface + Tag + layer 三件套(#501)。
export class FxService extends Effect.Service<FxService>()("oracle/FxService", {
  effect: Effect.gen(function* () {
    const cache = yield* CacheStore;
    const upstream = yield* FxUpstream;
    // —— 只有 `rateSeries` 用得到的两个端口 ——
    // 历史日汇率读写 `token_daily_prices`(按 ref 直存,见 `getDailyByRef`)。
    const prices = yield* TokenPriceStore;
    // BTC 反算两条腿走 `fetchPriceSeries(btcRef, …, vsCurrency)`(ADR 0026:复用现成取数口,
    // 不给 `FxUpstream` 加取数方法)。BTC 反算是全仓价格骨架的一部分,所以历史这半搭在代币上游上。
    const priceUpstream = yield* TokenUpstream;
    // 从 `FxUpstream` 只要 `btcRef` 一个字段 —— 那是 fx 与代币两个世界的桥(BTC 反算的基),
    // 留在 `FxUpstream` 上是对的,不为了消掉这条依赖去挪它。
    const { btcRef } = upstream;

    return {
      // 1 单位该币种值多少美元。USD 恒 1(不查缓存);缓存里没有 → `none`(调用方回退 USD)。
      resolve: (currency: string): Effect.Effect<Option.Option<number>> =>
        norm(currency) === "USD" ? Effect.succeed(Option.some(1)) : readFx(cache, currency),

      // 预热(同步之后 / 用户第一次切币种时)。缺省预热全部支持币种。
      warm: (currencies: readonly string[] = ALL_CODES): Effect.Effect<void> =>
        Effect.gen(function* () {
          // USD 不进目标:它恒为 1、不存缓存,算进去会让「全都新鲜」永远判不成立。
          const targets = [...new Set(currencies.map(norm))].filter((c) => c !== "USD");
          if (targets.length === 0) return;

          // 一次批量读:目标全都在且新鲜 → 什么都不做。
          const hits = yield* readFxFreshness(cache, targets);
          if (targets.every((c) => hits.get(fxKey(c))?.stale === false)) return;

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

      // 某法币在区间内逐日的 usd_per_unit,口径同 `resolve` 但按**当天**汇率(ADR 0026 / #274)。
      // SWR 照 `priceSeries`:命中缓存的过去日直接用、缺的从 BTC 反算并永久落 `token_daily_prices`、
      // 今日桶恒现取;上游失败 → 退回仅缓存。USD 恒 1(不出网)。
      // 缓存/派生对齐到 UTC 日桶(`atMs = 日桶 × 一日毫秒`)。
      rateSeries: (
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
            // 两条腿都走 `fetchPriceSeries(btcRef)`:BTC 该币(vsCurrency=CODE,现取不落)+
            // BTC 美元(优先缓存)。反算 = 后者 ÷ 前者。
            // **两条腿并发** —— 它们互不依赖,而这条路是用户在等历史曲线(串起来白赔一次往返)。
            // 任一腿挂 → 整块降级到仅缓存(记一行)。
            const legs = Effect.gen(function* () {
              const [series, btcUsd] = yield* Effect.all(
                [
                  priceUpstream.fetchPriceSeries(btcRef, fromMs, toMs, CODE),
                  btcUsdDaily(prices, priceUpstream, btcRef, buckets, todayB),
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
              degradeTo("fx.rateSeries", new Map<number, number>()),
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
  }),
}) {}

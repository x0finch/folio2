import type { CacheEntry } from "@folio/oracle-basic";
import { FX_TTL_MS, SUPPORTED_CURRENCIES } from "@folio/oracle-basic";
import { CacheStore, FxUpstream } from "@folio/oracle-basic/ports";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { degradeTo } from "./degrade";

// 展示币种的**现汇率**服务。**读软过期、写按 TTL** —— 两个动词的判据不同,这是本文件的全部内容。
//
// `resolve`(读)不看过期:汇率旧十分钟不会让总资产错到影响决策,而「暂时没有汇率」会让整个
// 认证区拿不到数字。所以有多旧都给,新鲜度由 `warm` 负责往上追。
// `warm`(写)才看过期:任一目标币种缺失或过期 → 一次拉全 → 逐个写回。
//
// **历史日汇率不在这儿**(`./fx-history` 的 `FxHistory`):那半靠 BTC 反算,依赖价 store 与
// 代币上游,与这两个动词一行逻辑都不共用。合住的时候本服务的 `R` 有四个服务,其中两个纯粹是
// 历史那半拖进来的 —— 现在缩回两个,而「测 resolve 读缓存」也只要 provide 两个假服务。
export interface FxRateResolver {
  // 1 单位该币种值多少美元。USD 恒 1(不查缓存);缓存里没有 → `none`(调用方回退 USD)。
  resolve(currency: string): Effect.Effect<Option.Option<number>>;
  // 预热(同步之后 / 用户第一次切币种时)。缺省预热全部支持币种。
  warm(currencies?: readonly string[]): Effect.Effect<void>;
}

export const FxRateResolver = Context.GenericTag<FxRateResolver>("oracle/FxRateResolver");

const ALL_CODES = SUPPORTED_CURRENCIES.map((c) => c.code);

// 币种 code 的归一口径。**造键与判「是不是 USD」共用这一个函数** —— 两处分开写过一次,
// 漏归一的话 `usd` 既不短路成 1、又永远不会被写进缓存(写的时候按大写过滤掉了),
// 于是每次预热都白拉一趟上游。
const norm = (code: string): string => code.trim().toUpperCase();

// —— 缓存那一侧:键、形状、三个读写口 ——
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

const make = Effect.gen(function* () {
  const cache = yield* CacheStore;
  const upstream = yield* FxUpstream;

  const resolver: FxRateResolver = {
    resolve: (currency) =>
      norm(currency) === "USD" ? Effect.succeed(Option.some(1)) : readFx(cache, currency),

    warm: (currencies = ALL_CODES) =>
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
  };

  return resolver;
});

export const fxRateResolverLayer: Layer.Layer<FxRateResolver, never, CacheStore | FxUpstream> =
  Layer.effect(FxRateResolver, make);

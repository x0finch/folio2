import type { UpstreamError } from "@folio/client-core";
import {
  type CacheStore,
  type FxUpstream,
  GlobalTokenRefIndexStore,
  type Namer,
  type PlatformUpstream,
  type TokenPriceStore,
  type TokenStore,
  TokenUpstream,
} from "@folio/oracle-basic/ports";
import { Clock, Context, Effect, Layer, type Option } from "effect";
import { candidateSourceLayer } from "./candidates";
import { type FiatHistory, fiatHistoryLayer } from "./fiat-history";
import { type FxRateResolver, fxRateResolverLayer } from "./fx";
import { type TokenMinter, tokenMinterLayer } from "./mint";
import { type PlatformResolver, platformResolverLayer } from "./platforms";
import { type TokenReader, tokenReaderLayer } from "./tokens";

// 装配。**`createOracleFor(cfg)` 没了** —— 那个 config 对象上挂着 7 个 `createXxx(userId)` 工厂
// 回调,正是 CODING.md 反复改掉的那个模式:能替换的东西该是**服务**(Layer),不是配置字段。
// 换掉它同时解决了三件事:
//   · 惰性(以前用 getter + `??=` 手写)由 Layer memoisation 免费给,而且**成本本来就没那么大** ——
//     `packages/db/src/connect.ts` 自己写着「drizzle(env.DB) 很轻,每次创建即可」,四个 store 全建
//     是常数级开销;当初那句「一拼 config 就把所有 store new 出来」担心的是不存在的代价
//   · `namer` / `overrides` 不再由装配点从 adapter 搬到服务层 —— adapter 的 layer 直接给 `Namer`
//   · `now?: () => number` 五个字段全删,时间走 `Clock`(测试 `TestClock`)
//
// **userId 仍然在类型上防错**:per-user 的三个 store layer 由 app 侧按 userId 现建
// (`oracleLayerFor(userId)`),服务层的方法签名里一个 user 参数都没有 —— 拿错用户在编译期
// 就发生不了,而这一层压根不知道有 userId 这回事。
//
// 一个用户的参考层由五个服务组成,按**领域**分(ADR 0012 的口径),不按能力切碎:
//   · `TokenReader`       读路径 —— 富化 / 现价 / 历史价 / 橱窗 / 搜索
//   · `TokenMinter`       写路径 —— tokenRef → token_id,写快照之前必须先过这一步
//   · `FxRateResolver`    展示币种**现**汇率 —— 与代币无关的一小块,只共用同一张 per-user 缓存
//   · `FiatHistory`       法币的**历史**日汇率 —— BTC 反算,落 `token_daily_prices`,不碰 user_cache
//   · `PlatformResolver`  链 ∪ 场馆的名与图
//
// **`DefiLogoResolver` 不在这儿了**(移回 app):DeFi 协议图来自用户自己同步下来的余额 meta,
// 没有上游、不出网 —— 它的 `R` 里一个上游都没有,那本身就是「它不属于参考层」的类型级写法。
// 现在它是 app 的 `defi-logo-store.ts`,同样落 `defi-logo:<协议>` 那个键。
//
// 「info 数据 vs 价格数据」的分离落在**端口**上(`TokenStore` / `TokenPriceStore`),
// 不在服务上再切一遍(ADR 0023)。
export type OracleServices =
  | TokenReader
  | TokenMinter
  | FxRateResolver
  | FiatHistory
  | PlatformResolver;

// 五个服务要的全部端口。app 侧提供这些,就拿到整个参考层。
export type OraclePorts =
  | TokenStore
  | TokenPriceStore
  | CacheStore
  | GlobalTokenRefIndexStore
  | TokenUpstream
  | FxUpstream
  | PlatformUpstream
  | Namer;

// `CandidateSource` 在这里被吃掉 —— 它是 mint 的内部依赖(#216 把它从 `TokenReader` 上摘下来的
// 那个),不该出现在装配点的 `R` 里。
export const oracleLayer: Layer.Layer<OracleServices, never, OraclePorts> = Layer.mergeAll(
  tokenReaderLayer,
  Layer.provide(tokenMinterLayer, candidateSourceLayer),
  fxRateResolverLayer,
  fiatHistoryLayer,
  platformResolverLayer,
);

// —— 全局维护任务 ——
// 刷全局映射表跟 userId 毫无关系(ADR 0022),所以它是独立的一个服务,不在 `oracleLayer` 里 ——
// cron 不必先假造一个用户,也不必把 per-user 的三个 store 建出来。动词沿用项目现成的 `warm`。
export interface RefIndexWarmer {
  // cron 调用点:拉 → 转换(在 adapter 里)→ 一次整份灌。返回这轮的账,供调用方记日志。
  //
  // **错误交出去,不降级** —— 与读路径相反:这里没有「本地旧值」可退,而 cron 需要知道这一轮
  // 白跑了(它会记日志 / 让平台重试)。降级在这儿等于把一次静默故障变成两次。
  warmRefIndex(): Effect.Effect<
    { rows: number; unmatchedPlatforms: readonly string[]; skipped: number },
    UpstreamError
  >;
  // 某个源最近一次成功刷新的时刻;从未刷过 → `none`(首次部署要手动触发一次)。
  refIndexRefreshedAt(): Effect.Effect<Option.Option<number>>;
}

export const RefIndexWarmer = Context.GenericTag<RefIndexWarmer>("oracle/RefIndexWarmer");

export const refIndexWarmerLayer: Layer.Layer<
  RefIndexWarmer,
  never,
  GlobalTokenRefIndexStore | TokenUpstream
> = Layer.effect(
  RefIndexWarmer,
  Effect.gen(function* () {
    const store = yield* GlobalTokenRefIndexStore;
    const upstream = yield* TokenUpstream;

    return {
      warmRefIndex: () =>
        Effect.gen(function* () {
          const result = yield* upstream.fetchRefIndex();
          // 失配是**静默故障**(那条链的币从此没价没图,却不报错)→ 必须喊出来。
          // 迁移前这是 `OracleWarmConfig.onWarn` 一个回调字段(「这一层不该知道日志怎么落」);
          // 现在走 Effect 自己的日志系统,而「落到哪」由 cron 提供的 Logger layer 决定 ——
          // 同一件事,少一个配置字段,而且 `Effect.logWarning` 在任何调用点都能用。
          if (result.unmatchedPlatforms.length > 0) {
            yield* Effect.logWarning(
              "global_token_ref_index: 链对照失配,这些链的币将没价没图",
            ).pipe(
              Effect.annotateLogs({
                namer: upstream.id,
                platforms: result.unmatchedPlatforms,
              }),
            );
          }
          yield* store.putAll(result.rows, yield* Clock.currentTimeMillis);
          return {
            rows: result.rows.length,
            unmatchedPlatforms: result.unmatchedPlatforms,
            skipped: result.skipped,
          };
        }),

      refIndexRefreshedAt: () => store.refreshedAt(upstream.id),
    };
  }),
);

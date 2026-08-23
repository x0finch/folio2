import type { UpstreamError } from "@folio/client-core";
import { GlobalTokenRefIndexStore, TokenUpstream } from "@folio/oracle-basic/ports";
import { Clock, Effect, type Option } from "effect";

// 全局映射表的维护门面(cron)。**不进 `oracleLayer`** —— 刷这张表跟 userId 毫无关系
// (ADR 0022),所以 cron 不必先假造一个用户、也不必把 per-user 的三个 store 建出来:
// 它单独 provide 本 layer + 那两个端口就能跑。
//
// 两个动词绑成一个服务,跟平台 / 汇率同款组织:调用点只有 `refreshGlobalRefIndex` 一处,
// 散成两个顶层函数不如一个 Tag 清楚。
//
// 动词沿用项目现成的 `warm`。
//
// **错误交出去,不降级** —— 与读路径相反:这里没有「本地旧值」可退,而 cron 需要知道这一轮
// 白跑了(它会记日志 / 让平台重试)。降级在这儿等于把一次静默故障变成两次。

// 服务的形状从下面这段 `effect` 的返回值推导,`.Default` 就是它的 layer —— 不再手写
// interface + Tag + layer 三件套(#501)。
export class GlobalRefIndexService extends Effect.Service<GlobalRefIndexService>()(
  "oracle/GlobalRefIndexService",
  {
    effect: Effect.gen(function* () {
      const store = yield* GlobalTokenRefIndexStore;
      const upstream = yield* TokenUpstream;

      return {
        // 拉 → 转换(在 adapter 里)→ 一次整份灌。返回这轮的账,供调用方记日志。
        warm: (): Effect.Effect<
          { rows: number; unmatchedPlatforms: readonly string[]; skipped: number },
          UpstreamError
        > =>
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

        // 某个源最近一次成功刷新的时刻;从未刷过 → `none`(首次部署要手动触发一次)。
        refreshedAt: (): Effect.Effect<Option.Option<number>> => store.refreshedAt(upstream.id),
      };
    }),
  },
) {}

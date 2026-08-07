import type { UpstreamError } from "@folio/client-core";
import { GlobalTokenRefIndexStore, TokenUpstream } from "@folio/oracle-basic/ports";
import { Clock, Effect, type Option } from "effect";

// 全局映射表的维护任务(cron)。**不在 `oracleLayer` 里,而且不是一个服务** —— 刷这张表跟
// userId 毫无关系(ADR 0022),所以 cron 不必先假造一个用户、也不必把 per-user 的三个 store
// 建出来:它直接 provide 这两个端口就能跑。
//
// **为什么这里没有 Tag。** 它曾经是 `RefIndexWarmer`(一个 `Context.GenericTag` + 一个 layer)。
// Tag 的意义是「这东西可以被换掉」—— 而它从来没有被换过:实现只有一个,web 侧的测试也从不
// 顶掉它(顶的是端口)。剩下的就只是仪式:一个 Tag、一个 layer、装配点一层 `Layer.provide`
// 嵌套,换来的是把两个函数的依赖从签名里藏起来。现在依赖就写在 `R` 上,cron 那一侧少一层包装。
//
// 动词沿用项目现成的 `warm`。
//
// **错误交出去,不降级** —— 与读路径相反:这里没有「本地旧值」可退,而 cron 需要知道这一轮
// 白跑了(它会记日志 / 让平台重试)。降级在这儿等于把一次静默故障变成两次。

// cron 调用点:拉 → 转换(在 adapter 里)→ 一次整份灌。返回这轮的账,供调用方记日志。
export const warmRefIndex = (): Effect.Effect<
  { rows: number; unmatchedPlatforms: readonly string[]; skipped: number },
  UpstreamError,
  GlobalTokenRefIndexStore | TokenUpstream
> =>
  Effect.gen(function* () {
    const store = yield* GlobalTokenRefIndexStore;
    const upstream = yield* TokenUpstream;

    const result = yield* upstream.fetchRefIndex();
    // 失配是**静默故障**(那条链的币从此没价没图,却不报错)→ 必须喊出来。
    // 迁移前这是 `OracleWarmConfig.onWarn` 一个回调字段(「这一层不该知道日志怎么落」);
    // 现在走 Effect 自己的日志系统,而「落到哪」由 cron 提供的 Logger layer 决定 ——
    // 同一件事,少一个配置字段,而且 `Effect.logWarning` 在任何调用点都能用。
    if (result.unmatchedPlatforms.length > 0) {
      yield* Effect.logWarning("global_token_ref_index: 链对照失配,这些链的币将没价没图").pipe(
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
  });

// 某个源最近一次成功刷新的时刻;从未刷过 → `none`(首次部署要手动触发一次)。
export const refIndexRefreshedAt = (): Effect.Effect<
  Option.Option<number>,
  never,
  GlobalTokenRefIndexStore | TokenUpstream
> =>
  Effect.gen(function* () {
    const store = yield* GlobalTokenRefIndexStore;
    const upstream = yield* TokenUpstream;
    return yield* store.refreshedAt(upstream.id);
  });

import type { UpstreamError } from "@folio/client-core";
import { Effect } from "effect";

// 「上游挂了就用本地旧值」这条降级贯穿整个参考层(现价、历史价、汇率、目录、元信息)。
// 迁移前它是 6 处 `try { … } catch { /* 降级 */ }`,两个毛病:
//   · **连自己的 bug 一起吞** —— parse 写错了抛 TypeError,与一次 429 长得一模一样,静默降级
//   · **一行痕迹都不留** —— 上游整晚限流,日志里什么都没有,只有用户看到旧价
//
// 改成按类型接:`UpstreamError`(client-core 那四类 tagged error)被接住并记一行,
// 其余一切(defect —— 也就是我们自己的 bug)照样炸到 `runPromise`。
export const degradeTo =
  <A>(at: string, fallback: A) =>
  <R>(self: Effect.Effect<A, UpstreamError, R>): Effect.Effect<A, never, R> =>
    Effect.catchAll(self, (error) => Effect.as(logDegraded(at, error), fallback));

// 只记 tag / pathname / 状态码。**`where` 刻意不带 query**(client-core 的契约),所以这一行
// 不可能出现 API key、签名或钱包地址(原则 #5 红线)。
//
// 单独导出是因为有一处不能用 `degradeTo`:预热那条路除了记一行,还要把「挂了」带回给调用方
// (`RefreshStaleReport.degraded`),所以它自己 `Effect.either` 之后调这个。
export const logDegraded = (at: string, error: UpstreamError): Effect.Effect<void> =>
  Effect.logWarning("oracle: upstream fetch failed, serving local data").pipe(
    Effect.annotateLogs({
      at,
      upstream: error.upstream,
      error: error._tag,
      where: error.where,
      status: error.status,
    }),
  );

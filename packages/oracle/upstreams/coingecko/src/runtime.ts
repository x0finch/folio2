import {
  FolioHttpClient,
  isRetryable,
  type Outbound,
  retryAfterOf,
  type UpstreamError,
} from "@folio/client-core";
import {
  CoinGeckoClient,
  type CoinGeckoClientApi,
  type CoinGeckoConfig,
} from "@folio/coingecko-client";
import { Duration, Effect, Layer, Schedule } from "effect";
import { RETRY_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_WAIT_MS, UPSTREAM_ID } from "./constants";

// —— 本包的 Effect ↔ Promise 边界 ——
//
// `TokenUpstream` / `FxUpstream` / `PlatformUpstream` 三个端口是 **Promise 形状**(`@folio/oracle-basic`),
// 而 client 是 Effect 形状。边界必须落在某处,落这里:
//
//   · **不往上推**(把三个端口改成 Effect)—— 那是 oracle 服务层整体迁移,是 epic #362 的下一站,
//     不是本片。端口一改,`@folio/oracle` 的 SWR 编排、缓存、mint 决策全要跟着动
//   · **不往下推**(让 client 出口转 Promise)—— 那等于白用:外层的超时和中断管不到里面,
//     而且它是九个 client 的共同形状,为一个消费者破例会传染
//
// 与 `@folio/sync` 同一个办法:包内全 Effect,公开出口是 Promise,`runPromise` 只有一处。

// 请求级的重试。**挂在单发请求上,不是整个方法上** —— `fetchMarkets` 翻四页,第三页失败该重打
// 第三页,不是从第一页重来。老那版把重试放在传输层里,天然就是这个粒度;换成显式的之后
// 得自己保证,所以每个 `client.xxx` 调用点都裹这一层。
const policy = Schedule.exponential(Duration.millis(RETRY_BASE_MS)).pipe(
  // 只重试可重试的;**并且上游建议的等待超过我们肯等的上限就直接放弃**。
  // 这是老 `withRetry` 的 `exceedsMaxWait: "throw"`:这条路可能挂在用户的写路径上,
  // 夹到 2 秒再打大概率还是 429,白赔一次往返 —— 不如让 SWR 顶旧数据。
  // **必须排在 passthrough 前** —— 它负责把输入类型钉成 `UpstreamError`。
  Schedule.whileInput((e: UpstreamError) => {
    if (!isRetryable(e)) return false;
    const suggested = retryAfterOf(e);
    return suggested === undefined || suggested <= RETRY_MAX_WAIT_MS;
  }),
  // 把输出换成输入(错误本身),下一行才看得见 Retry-After。
  Schedule.passthrough,
  // 上游说了等多久就听它的,没说才用指数值;两者都夹在单次上限内。
  Schedule.modifyDelay((err, computed) => {
    const suggested = retryAfterOf(err);
    return Duration.min(
      Duration.millis(RETRY_MAX_WAIT_MS),
      suggested !== undefined ? Duration.millis(suggested) : computed,
    );
  }),
  // 抖动:一把 key 全部署共用,多个调用者常常同时撞 429,按同一个 Retry-After 醒来会精确地
  // 再撞一次。加性(+0~baseMs)不用 Effect 自带的 `jittered`(乘性会让退避短于基数)。
  Schedule.addDelay(() => Duration.millis(Math.random() * RETRY_BASE_MS)),
  Schedule.intersect(Schedule.recurs(RETRY_ATTEMPTS - 1)),
);

// 一发请求 + 重试。每个 `client.xxx` 调用点写一次。
export const req = <A>(
  effect: Effect.Effect<A, UpstreamError, Outbound>,
): Effect.Effect<A, UpstreamError, Outbound> => Effect.retry(effect, policy);

// 拿 client 说话 —— 三个 adapter 的方法体都长这个样子。
export const withClient = <A>(
  use: (client: CoinGeckoClientApi) => Effect.Effect<A, UpstreamError, Outbound>,
): Effect.Effect<A, UpstreamError, CoinGeckoClient | Outbound> =>
  Effect.flatMap(CoinGeckoClient, use);

// 类型化的失败 → 普通 `Error`。**不让 `FiberFailure` 漏给调用方**:`runPromise` 默认抛的是它,
// 而 `Data.TaggedError` 的这四类没有 `message` 字段,于是上层日志里只剩一个空消息 + 一坨 Cause。
//
// 消息里只有 tag、pathname 和状态码 —— `where` 本来就刻意不带 query(原则 #5 红线),
// 这里也不额外拼任何东西上去。
const toError = (error: UpstreamError): Error =>
  new Error(
    `${UPSTREAM_ID} ${error._tag} on ${error.where}${error.status !== undefined ? ` (${error.status})` : ""}`,
    { cause: error },
  );

// 跑一个用了 client 的 effect,吐 Promise。**每次调用建一次层** —— 闸的状态不在层里
// (`isolated` 档的游标是模块级、按 key 存的),所以重建不会让额度凭空回满。
export const runnerFor = (
  config: CoinGeckoConfig,
): (<A>(effect: Effect.Effect<A, UpstreamError, CoinGeckoClient | Outbound>) => Promise<A>) => {
  const layer = Layer.mergeAll(CoinGeckoClient.layer(config), FolioHttpClient);
  return <A>(effect: Effect.Effect<A, UpstreamError, CoinGeckoClient | Outbound>): Promise<A> =>
    Effect.runPromise(Effect.either(Effect.provide(effect, layer))).then((result) => {
      // **`throw`,不是 `Promise.reject(...)`**:后者在回调里现造一个已拒绝的 promise,
      // 而它被外层收养要等下一个微任务 —— workerd 在那之前就已经报了一次 unhandledrejection。
      // 结果是 apps/web 的 workers 测试里,每个「上游挂了但被吞掉」的用例都多一条未处理拒绝
      // (代码是对的,报告是脏的)。`throw` 直接拒绝外层,中间不存在第二个 promise。
      if (result._tag === "Left") throw toError(result.left);
      return result.right;
    });
};

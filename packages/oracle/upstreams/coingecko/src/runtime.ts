import { isRetryable, type Outbound, retryAfterOf, type UpstreamError } from "@folio/client-core";
import { CoinGeckoClient, type CoinGeckoClientApi } from "@folio/coingecko-client";
import { Duration, Effect, Schedule } from "effect";
import { RETRY_ATTEMPTS, RETRY_BASE_MS, RETRY_MAX_WAIT_MS } from "./constants";

// 本包共用的两件事:**一发请求的重试策略**,和**怎么拿到 client 说话**。
//
// 以前这里还有第三件 —— `runnerFor`(Effect → Promise 的边界)。它没了:三个端口
// (`TokenUpstream` / `FxUpstream` / `PlatformUpstream`)从 #362 第 4 站起本身就是 Effect 形状,
// 所以「跑」这件事归调用方,`runPromise` 只剩 apps/web 的入口一处。连带删掉的 `toError`
// (tagged error → `Error`)也搬到了那一处 —— FiberFailure 该在哪儿翻译成日志,那儿才知道。

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

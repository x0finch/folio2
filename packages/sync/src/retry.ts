import {
  type ConnectorError,
  ConnectorUnavailableError,
  isRetryable,
  retryAfterOf,
} from "@folio/connectors-basic";
import type { AccountSafe } from "@folio/db";
import { Duration, Effect, Schedule } from "effect";
import { FETCH_TIMEOUT_MS, RETRY_BASE_MS, RETRY_MAX_ATTEMPTS, RETRY_MAX_MS } from "./constants";
import { BalanceSource } from "./services";
import type { FetchOutcome } from "./types";

// 取余额失败后的退避重试。**后台同步**用,没人在等 —— 所以宁可多等也不轻易放弃。
// 策略是个值:能单独读懂、单独改、单独测,不散在调用点的参数里。
const retryPolicy = Schedule.exponential(Duration.millis(RETRY_BASE_MS)).pipe(
  // 只重试可重试的。**必须排在 passthrough 前**:它负责把输入类型钉成 ConnectorError,
  // 反过来写运行时正确但类型会塌成 unknown,下面就拿不到 retryAfterMs 了。
  //
  // 判据是 `_tag`(经 `isRetryable`),不是从前那个 `retryable` 布尔:布尔是鸭子类型,谁都能忘了传,
  // 而且它得靠一座桥从 `ProviderError` 抄过来 —— 抄漏一次就是「限流了却不重试」。
  // `isRetryable` 住在契约包里,加一个 tag 会让它当场编译红。
  Schedule.whileInput((e: ConnectorError) => isRetryable(e)),
  // 把输出换成输入(错误本身),下一行才看得见 Retry-After。
  Schedule.passthrough,
  // 上游说了等多久就听它的,没说才用指数值;两者都夹在单次上限内 —— 夹住而不是放弃(clamp)。
  Schedule.modifyDelay((err, computed) => {
    const suggested = retryAfterOf(err);
    return Duration.min(
      Duration.millis(RETRY_MAX_MS),
      suggested !== undefined ? Duration.millis(suggested) : computed,
    );
  }),
  // 抖动,防止 6 路并发同时撞 429 后又踩着同一个点一起醒来。
  // 用加性(+0~200ms)不是 Effect 自带的 jittered(乘性 0.8~1.2 倍)—— 后者会让退避短于基数,是行为改变。
  Schedule.addDelay(() => Duration.millis(Math.random() * RETRY_BASE_MS)),
  // 封顶重试 2 次(总尝试 3 次)。
  Schedule.intersect(Schedule.recurs(RETRY_MAX_ATTEMPTS - 1)),
  // 重试日志。输出元组第二位就是 `recurs` 数到的已重试次数(0 起),+1 即 attempt —— 不必自己在
  // 外面攒一个可变计数器。省掉它之后策略才能是个模块级常量(以前得在函数里现拼,只为闭包住它)。
  // 账户上下文字段不在这里拼:syncAccount 已经 annotate 过,隔着 Schedule 也照样带下来。
  //
  // **谓词必须在这里重判一遍**,虽然看着和上面的 whileInput / recurs 重复:Schedule 决定「到此
  // 为止」时**照样会把这一次的输出发出来**,tapOutput 分不出这是「再来一次」还是「就此放弃」。
  // 不重判的话,不可重试的错误会记一条「retrying」(其实没重试)、重试用尽会多记第 3 条。
  // 两个条件正是迁移前 `withRetry` 的退出判据(`!isRetryable || attempt >= attempts` 就 throw,
  // 不回调 onRetry),照抄它才叫时机一致。tests 两条分别钉住这两种情形的条数。
  Schedule.tapOutput(([err, recurrence]: readonly [ConnectorError, number]) =>
    isRetryable(err) && recurrence < RETRY_MAX_ATTEMPTS - 1
      ? Effect.logWarning("provider call retrying").pipe(
          Effect.annotateLogs({
            attempt: recurrence + 1,
            // 记 `_tag` 而不是从前那个 `code` —— 它就是重试判据本身,查日志时「为什么重试了」
            // 和「为什么没重试」看同一个字段。
            reason: err._tag,
            retryAfterMs: retryAfterOf(err),
          }),
        )
      : Effect.void,
  ),
);

// 取一次余额,带超时。
const once = (
  account: AccountSafe,
  stored: Record<string, string>,
): Effect.Effect<FetchOutcome, ConnectorError, BalanceSource> =>
  Effect.flatMap(BalanceSource, (source) => source.fetch(account, stored)).pipe(
    // 超时归「够不到上游」—— 语义正好(等太久 = 这一轮拿不到)且可重试,策略仍然只认识一种错误。
    // 用 timeoutFail 不用 Effect.timeout —— 后者会往错误通道塞一个 TimeoutException,
    // 和只认 ConnectorError 的策略类型对不上,编译期就红。
    Effect.timeoutFail({
      duration: Duration.millis(FETCH_TIMEOUT_MS),
      onTimeout: () => new ConnectorUnavailableError({ message: "provider fetch timed out" }),
    }),
  );

// 取余额 + 退避重试。**只有取数重试,写快照不重试。**
export const fetchBalancesWithRetry = (
  account: AccountSafe,
  stored: Record<string, string>,
): Effect.Effect<FetchOutcome, ConnectorError, BalanceSource> =>
  Effect.retry(once(account, stored), retryPolicy);

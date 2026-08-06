import type { AccountSafe } from "@folio/db";
import { Duration, Effect, Schedule } from "effect";
import { FETCH_TIMEOUT_MS, RETRY_BASE_MS, RETRY_MAX_ATTEMPTS, RETRY_MAX_MS } from "./constants";
import { FetchBalancesError } from "./errors";
import { Balances } from "./services";
import type { FetchOutcome } from "./types";

// 取余额失败后的退避重试。**后台同步**用,没人在等 —— 所以宁可多等也不轻易放弃。
// 策略是个值:能单独读懂、单独改、单独测,不散在调用点的参数里。
const retryPolicy = Schedule.exponential(Duration.millis(RETRY_BASE_MS)).pipe(
  // 只重试可重试的。**必须排在 passthrough 前**:它负责把输入类型钉成 FetchBalancesError,
  // 反过来写运行时正确但类型会塌成 unknown,下面就拿不到 retryAfterMs 了。
  Schedule.whileInput((e: FetchBalancesError) => e.retryable),
  // 把输出换成输入(错误本身),下一行才看得见 Retry-After。
  Schedule.passthrough,
  // 上游说了等多久就听它的,没说才用指数值;两者都夹在单次上限内 —— 夹住而不是放弃(clamp)。
  Schedule.modifyDelay((err, computed) =>
    Duration.min(
      Duration.millis(RETRY_MAX_MS),
      err.retryAfterMs !== undefined ? Duration.millis(err.retryAfterMs) : computed,
    ),
  ),
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
  Schedule.tapOutput(([err, recurrence]: readonly [FetchBalancesError, number]) =>
    err.retryable && recurrence < RETRY_MAX_ATTEMPTS - 1
      ? Effect.logWarning("provider call retrying").pipe(
          Effect.annotateLogs({
            attempt: recurrence + 1,
            code: err.code,
            retryAfterMs: err.retryAfterMs,
          }),
        )
      : Effect.void,
  ),
);

// 取一次余额,带超时。
const once = (
  account: AccountSafe,
  stored: Record<string, string>,
): Effect.Effect<FetchOutcome, FetchBalancesError, Balances> =>
  Effect.flatMap(Balances, (balances) => balances.fetch(account, stored)).pipe(
    // 超时也产出 FetchBalancesError(retryable),这样重试策略只认识一种错误。
    // 用 timeoutFail 不用 Effect.timeout —— 后者会往错误通道塞一个 TimeoutException,
    // 和只认 FetchBalancesError 的策略类型对不上,编译期就红。
    // 注:只是停止等待,不真 abort 底层 fetch(CF 上 dangling fetch 随 isolate 回收)。
    Effect.timeoutFail({
      duration: Duration.millis(FETCH_TIMEOUT_MS),
      onTimeout: () =>
        new FetchBalancesError({
          message: "provider fetch timed out",
          code: "UPSTREAM_ERROR",
          retryable: true,
        }),
    }),
  );

// 取余额 + 退避重试。**只有取数重试,写快照不重试。**
export const fetchBalancesWithRetry = (
  account: AccountSafe,
  stored: Record<string, string>,
): Effect.Effect<FetchOutcome, FetchBalancesError, Balances> =>
  Effect.retry(once(account, stored), retryPolicy);

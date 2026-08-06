import type { AccountSafe } from "@folio/db";
import { Duration, Effect, Schedule } from "effect";
import { FETCH_TIMEOUT_MS, RETRY_BASE_MS, RETRY_MAX_ATTEMPTS, RETRY_MAX_MS } from "./constants";
import { FetchBalancesError } from "./errors";
import { Balances, SyncLog } from "./services";
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
);

// 取一次余额,带超时。
const once = (account: AccountSafe, stored: Record<string, string>) =>
  Effect.gen(function* () {
    const balances = yield* Balances;
    return yield* balances.fetch(account, stored);
  }).pipe(
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
  logFields: Record<string, unknown>,
): Effect.Effect<FetchOutcome, FetchBalancesError, Balances | SyncLog> =>
  Effect.gen(function* () {
    const log = yield* SyncLog;
    let attempt = 0;
    const logged = retryPolicy.pipe(
      // 日志挂在 schedule 上而不是 tapError 上:它只在**决定再来一次**时触发,
      // 所以「不可重试」和「重试用尽」都不会多记一条。
      Schedule.tapOutput(([err]: readonly [FetchBalancesError, number]) =>
        Effect.sync(() => {
          attempt += 1;
          log.warning("provider call retrying", {
            ...logFields,
            attempt,
            code: err.code,
            retryAfterMs: err.retryAfterMs,
          });
        }),
      ),
    );
    return yield* once(account, stored).pipe(Effect.retry(logged));
  });

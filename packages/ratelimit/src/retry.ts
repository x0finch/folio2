import type { RetryOpts } from "./types";

// 退避重试。搬自 @folio/sync 的 orchestrator(那份形状本来就对),两处改动:
//   ① 判据改成**鸭子类型** —— 只看 `err.retryable` / `err.retryAfterMs`,不 instanceof 任何类。
//      四个错误类的字段名一样,统一基类是大改动而且方向错(oracle 不该依赖 connectors)。
//   ② 次数 / 上限 / 基数**由调用方传**。三处的账本来就不同:sync 是后台(3 次 / 5s),
//      CoinGecko 在写路径(mint 冷启动时用户在等),探活是用户盯着表单。
//
// **抖动不是可选的**:多个调用者同时撞 429 是常态(同一把 CGK key 上有 Promise.all 两发、
// 有 6 路并发的账户同步、还有别的 isolate 里的别的用户)。它们要是都按同一个 Retry-After
// 醒来,会精确地再撞一次。

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function isRetryableByDuckType(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { retryable?: unknown }).retryable === true
  );
}

function retryAfterMsOf(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as { retryAfterMs?: unknown }).retryAfterMs;
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOpts): Promise<T> {
  const {
    attempts,
    maxWaitMs,
    baseMs,
    exceedsMaxWait = "throw",
    sleep = defaultSleep,
    random = Math.random,
    isRetryable = isRetryableByDuckType,
    onRetry,
  } = opts;

  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (error) {
      if (!isRetryable(error) || attempt >= attempts) throw error;

      const retryAfterMs = retryAfterMsOf(error);
      // 上游说「等 60 秒」而我们只肯等 2 秒 —— 那就不等了。夹到 2 秒再打大概率还是 429,
      // 白赔一次往返;抛出去让调用方(SWR / 表单)自己决定降级还是报错。
      if (retryAfterMs !== undefined && retryAfterMs > maxWaitMs && exceedsMaxWait === "throw") {
        throw error;
      }

      const backoffMs = Math.min(maxWaitMs, baseMs * 2 ** (attempt - 1));
      const waitMs = Math.min(maxWaitMs, retryAfterMs ?? backoffMs) + random() * baseMs;
      onRetry?.({ attempt, error, waitMs });
      await sleep(waitMs);
    }
  }
}

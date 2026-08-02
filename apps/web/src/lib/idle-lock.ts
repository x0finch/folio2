// 闲置锁判定(ADR 0029 / #291）。纯函数，主动定时器与重入比对共用同一判据。
// timeoutMs = null 表示「永不锁」；now < lastActiveAt(时钟回拨)保守处理为不锁 ——
// 威胁模型是防顺手偷看，时钟异常时宁可不误锁打扰用户。

/** 可选的闲置分钟数(pill 顺序，末尾另有「永不」)。单一源：设置页 pill 与 parseIdleTimeout 校验共用。 */
export const IDLE_TIMEOUT_MINUTES = [1, 5, 15, 30] as const;

/** localStorage 存超时偏好的键；值为 "1" | "5" | "15" | "30" | "never"。 */
export const IDLE_TIMEOUT_STORAGE_KEY = "folio_lock_timeout";

/** 默认偏好:永不锁。未设 / 缺失时的回落 —— 自动锁默认关，用户自行在设置里开。 */
export const DEFAULT_IDLE_TIMEOUT_RAW = "never";

export function shouldLock(opts: {
  lastActiveAt: number;
  now: number;
  timeoutMs: number | null;
}): boolean {
  if (opts.timeoutMs === null) return false; // 永不
  const elapsed = opts.now - opts.lastActiveAt;
  if (elapsed < 0) return false; // 时钟回拨，保守不锁
  return elapsed >= opts.timeoutMs;
}

// 偏好字符串 → 毫秒 / null(永不)。合法分钟档 → 毫秒;缺失 / 非法 → 默认永不(null)。
export function parseIdleTimeout(raw: string | null): number | null {
  if (raw === "never") return null;
  const n = Number(raw);
  return (IDLE_TIMEOUT_MINUTES as readonly number[]).includes(n) ? n * 60_000 : null;
}

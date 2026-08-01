// 闲置锁判定(ADR 0029 / #291）。纯函数，主动定时器与重入比对共用同一判据。
// timeoutMs = null 表示「永不锁」；now < lastActiveAt(时钟回拨)保守处理为不锁 ——
// 威胁模型是防顺手偷看，时钟异常时宁可不误锁打扰用户。

/** 默认闲置超时：5 分钟。S1 固定用它；S2 起改为设置页可配(#292)。 */
export const DEFAULT_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

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

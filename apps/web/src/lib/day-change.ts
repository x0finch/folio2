import type { HistoryPoint } from "./history";

// 组合 24h【价值】变化(头部 Badge):当前总额 − 约 24h 前的组合净值(取历史序列里最接近 now-24h 的点)。
// 反映价格波动 + 持仓变动(充值/交易/新账户)的真实净值日变化;快照稀疏时(窗口内无点)返回 null → 隐藏 Badge。
// nowMs 传"最新快照时刻"(= series 末点 t),使基准与 currentTotal 同源、SSR/客户端一致、不用客户端时钟。
const DAY_MS = 24 * 60 * 60 * 1000;

export function computeDayChange(
  series: readonly HistoryPoint[],
  currentTotal: number,
  nowMs: number,
  windowMs = 18 * 60 * 60 * 1000,
): number | null {
  if (series.length === 0) return null;
  const target = nowMs - DAY_MS;
  let best: HistoryPoint | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const p of series) {
    const d = Math.abs(p.t - target);
    if (d < bestDist) {
      bestDist = d;
      best = p;
    }
  }
  if (!best || bestDist > windowMs) return null; // 窗口内无参照点 → 不显示(不硬凑)
  return currentTotal - best.total;
}

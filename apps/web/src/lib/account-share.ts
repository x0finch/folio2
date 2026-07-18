// 账户占比派生(纯逻辑,可单测)。占比 = 该账户市值 / 活跃账户总计(顶部总计合计)。
// 归档账户市值为 0 且不进总计(见 accounts.tsx loader:归档不在 overview.rows → totalUsd 0),
// 故总计只合计未归档账户。总计 ≤ 0(无账户 / 全空)→ 占比 0,避免除零 / 负分母。

export function activeAccountsTotal(
  rows: { totalUsd: number; archivedAt: number | null }[],
): number {
  return rows.reduce((s, r) => (r.archivedAt == null ? s + r.totalUsd : s), 0);
}

export function accountShare(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

// 占比展示标签(不含 %,由 UI 补 "%" 后缀):>0 且 <1 统一显示 "<1.0"(→ "<1.0%"),否则一位小数。
// 让极小占比不显示成误导性的 "0.3%",而是明确的 "<1.0%"。
export function shareLabel(pct: number): string {
  return pct > 0 && pct < 1 ? "<1.0" : pct.toFixed(1);
}

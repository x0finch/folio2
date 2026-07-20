// 缺凭据账户是否带"陈旧持仓"(导入含快照 → 有历史持仓)。用于详情抽屉分支:
// true → 显示陈旧持仓 + "上次同步 N 天前"标注;false(从未同步 / 无持仓)→ 空态占位。
export function hasStaleHoldings(account: {
  takenAt: number | null;
  balances: readonly unknown[];
}): boolean {
  return account.takenAt != null && account.balances.length > 0;
}

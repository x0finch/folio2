// 单币 24h 增值(美元):由当前市值与 24h% 反推 —— 前值 = 市值/(1+pct/100),增值 = 市值 − 前值。
// 与 hero 第二行同语义(增值 + %);无 change24h / 恰好 0 / 前值不合法(≤-100%)→ 返回 null(不显示)。
// 代币行(token-holdings)与详情抽屉(asset-sheet)共用。
export function dayValueChange(totalValue: number, change24h?: number): number | null {
  if (change24h == null || change24h === 0) return null;
  const factor = 1 + change24h / 100;
  if (factor <= 0) return null;
  return totalValue - totalValue / factor;
}

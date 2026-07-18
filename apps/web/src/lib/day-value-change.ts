// 单币 24h 增值(美元):由当前市值与 24h% 反推 —— 前值 = 市值/(1+pct/100),增值 = 市值 − 前值。
// 与 hero 第二行同语义(增值 + %);无 change24h / 恰好 0 / 前值不合法(≤-100%)→ 返回 null(不显示)。
// 代币行(token-holdings)与详情抽屉(asset-sheet)共用。
export function dayValueChange(totalValue: number, change24h?: number): number | null {
  if (change24h == null || change24h === 0) return null;
  const factor = 1 + change24h / 100;
  if (factor <= 0) return null;
  return totalValue - totalValue / factor;
}

// 一组持仓行的 24h 增值聚合(全站统一:DeFi 协议行 protocolDayChange / 账户行 <ValueDelta> 共用)。
// delta = 逐行 dayValueChange 之和(负债行负值 → 升值为负贡献,方向天然正确)。
// pct 分母 = 总敞口前值 Σ|前值|(全量行的 |前值| 之和,缺 change24h 的行按现值计):用净值当分母会在
// 对冲仓(存≈借,净值近零)与部分富化(分母只剩小行)时产生荒谬百分比。全行无一带 change24h → null。
export function aggregateDayChange(
  rows: { usdValue: number; change24h?: number }[],
): { delta: number; pct: number | null } | null {
  let delta = 0;
  let grossPrev = 0;
  let any = false;
  for (const r of rows) {
    const d = dayValueChange(r.usdValue, r.change24h);
    if (d != null) {
      any = true;
      delta += d;
    }
    grossPrev += Math.abs(r.usdValue - (d ?? 0));
  }
  if (!any) return null;
  return { delta, pct: grossPrev !== 0 ? (delta / grossPrev) * 100 : null };
}

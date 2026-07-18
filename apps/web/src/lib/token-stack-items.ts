import type { OverviewBalance } from "./account-view";

// 账户持有代币 → 叠标 items(纯逻辑,可单测)。按 symbol 去重(忽略大小写)、合计各币美元价值、
// 按合计价值降序;保留首见的 symbol 展示与 logo。渲染交给全站统一的 <AvatarStack>(代币行 / 账户行共用)。
export interface StackItem {
  logo?: string;
  name: string;
  k: string;
}

export function tokenStackItems(balances: OverviewBalance[]): StackItem[] {
  const byToken = new Map<string, { symbol: string; logo?: string; value: number }>();
  for (const bal of balances) {
    const key = bal.symbol.toUpperCase();
    const cur = byToken.get(key);
    if (cur) cur.value += bal.usdValue;
    else byToken.set(key, { symbol: bal.symbol, logo: bal.logo, value: bal.usdValue });
  }
  return [...byToken.values()]
    .sort((a, b) => b.value - a.value)
    .map((t) => ({ logo: t.logo, name: t.symbol, k: t.symbol }));
}

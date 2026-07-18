import type { OverviewBalance } from "./account-view";
import { viewKind } from "./balance-kind";

// 账户持有代币 → 叠标 items(纯逻辑,可单测)。**只取现货(spot)** —— 叠标语义是"持有代币",
// DeFi 头寸腿(可能负值负债腿/无 logo)、永续权益与仓位(perp 仓位 symbol 是标的 coin,非持币)
// 不是"持有代币",混进来会误导且负值乱序,故按 viewKind 过滤(与 toAccountSections 的 spot 分区口径一致)。
// 现货内按 symbol 去重(忽略大小写)、合计美元价值、按价值降序;保留首见 symbol/logo。
// 渲染交给全站统一的 <AvatarStack>。
export interface StackItem {
  logo?: string;
  name: string;
  k: string;
}

export function tokenStackItems(balances: OverviewBalance[]): StackItem[] {
  const byToken = new Map<string, { symbol: string; logo?: string; value: number }>();
  for (const bal of balances) {
    if (viewKind(bal) !== "spot") continue; // 只叠现货持币,滤掉 defi/perp
    const key = bal.symbol.toUpperCase();
    const cur = byToken.get(key);
    if (cur) cur.value += bal.usdValue;
    else byToken.set(key, { symbol: bal.symbol, logo: bal.logo, value: bal.usdValue });
  }
  return [...byToken.values()]
    .sort((a, b) => b.value - a.value)
    .map((t) => ({ logo: t.logo, name: t.symbol, k: t.symbol }));
}

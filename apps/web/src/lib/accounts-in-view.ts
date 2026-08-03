import type { PortfolioMembership } from "@folio/db";

// 聚合边界的**单一事实源过滤**(ADR 0033)。总额 / 代币 / Perps / DeFi / 构成 / 曲线 / Insights
// 全部源自这里 —— 加一个 portfolioId 维度即全线一致,数字不自相矛盾。
//
// 「在某视图里」= 归属选中的 Portfolio **且** 未归档(与归档正交,各管一件事)。
// 兜底:**未归属**的账户(理论上不该有,每账户恰一行归属)落进**默认** Portfolio 的视图 ——
// 宁可多显示也不让一个账户因缺一行归属而从净值里凭空消失(钱不能隐形)。

// 某归属是否属于当前视图:命中选中的即是;没有归属行的账户只在「看默认 Portfolio」时兜底计入。
function inView(
  membershipPortfolioId: string | undefined,
  selectedPortfolioId: string,
  defaultPortfolioId: string,
): boolean {
  if (membershipPortfolioId === selectedPortfolioId) return true;
  if (membershipPortfolioId === undefined && selectedPortfolioId === defaultPortfolioId)
    return true;
  return false;
}

// 活跃(未归档)且归属选中 Portfolio 的账户 —— 喂 buildOverview / 曲线当下点。
export function accountsInView<A extends { id: string; archivedAt: number | null }>(
  accounts: A[],
  memberships: PortfolioMembership[],
  selectedPortfolioId: string,
  defaultPortfolioId: string,
): A[] {
  const portfolioOf = new Map(memberships.map((m) => [m.accountId, m.portfolioId]));
  return accounts.filter(
    (a) =>
      a.archivedAt == null &&
      inView(portfolioOf.get(a.id), selectedPortfolioId, defaultPortfolioId),
  );
}

// 归属选中 Portfolio 的账户 id 集(**与归档无关**)—— 历史曲线的过去点按它 scope:
// 曲线追溯性地只算当前成员(含已归档成员的过去贡献),移进/移出 Portfolio 整条曲线重算(ADR 0033)。
export function accountIdsInView(
  accountIds: string[],
  memberships: PortfolioMembership[],
  selectedPortfolioId: string,
  defaultPortfolioId: string,
): Set<string> {
  const portfolioOf = new Map(memberships.map((m) => [m.accountId, m.portfolioId]));
  return new Set(
    accountIds.filter((id) => inView(portfolioOf.get(id), selectedPortfolioId, defaultPortfolioId)),
  );
}

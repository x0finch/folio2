import type { AccountTagLink, PortfolioMembership } from "@folio/db";

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

// 自定义 Tab(pin,ADR 0034)的过滤目标:指向单个 Connector / Tag / Account。null = 默认视图(不收窄)。
export type TabPin =
  | { kind: "connector"; connectorId: string }
  | { kind: "tag"; tagId: string }
  | { kind: "account"; accountId: string };

// 客户端/入参那份松散的 pin scope(kind + 三个可选 id)→ 规范化成 TabPin 联合。
// 缺对应 id(或整个缺省)= 视作无 pin(退回不收窄)。与 accountsMatchingPin 同处一模块、同被单测。
export type TabPinScope =
  | {
      kind: "connector" | "tag" | "account";
      connectorId?: string;
      tagId?: string;
      accountId?: string;
    }
  | null
  | undefined;

export function toTabPin(scope: TabPinScope): TabPin | null {
  if (!scope) return null;
  if (scope.kind === "connector" && scope.connectorId) {
    return { kind: "connector", connectorId: scope.connectorId };
  }
  if (scope.kind === "tag" && scope.tagId) return { kind: "tag", tagId: scope.tagId };
  if (scope.kind === "account" && scope.accountId) {
    return { kind: "account", accountId: scope.accountId };
  }
  return null;
}

// 在**已按 Portfolio 过滤**的账户集上再按 pin 收窄(自定义 Tab)。pin=null → 原样返回(默认视图)。
// 与 accountsInView 组合使用:accountsMatchingPin(accountsInView(...), pin, tagLinks)——作用域仍是
// 「当前 Portfolio 内」,pin 只在其内再筛(ADR 0034:pin 不跨 Portfolio)。纯函数,单一事实源。
export function accountsMatchingPin<A extends { id: string; connectorId: string }>(
  accounts: A[],
  pin: TabPin | null,
  tagLinks: AccountTagLink[],
): A[] {
  if (!pin) return accounts;
  if (pin.kind === "connector") {
    return accounts.filter((a) => a.connectorId === pin.connectorId);
  }
  if (pin.kind === "account") {
    return accounts.filter((a) => a.id === pin.accountId);
  }
  const tagged = new Set(tagLinks.filter((l) => l.tagId === pin.tagId).map((l) => l.accountId));
  return accounts.filter((a) => tagged.has(a.id));
}

// 归属选中 Portfolio 的账户 id 集(**与归档无关**)—— 历史曲线的过去点按它 scope:
// 曲线追溯性地只算当前成员(含已归档成员的过去贡献),移进/移出 Portfolio 整条曲线重算(ADR 0033)。
export function accountIdsInView(
  accountIds: string[],
  memberships: readonly PortfolioMembership[],
  selectedPortfolioId: string,
  defaultPortfolioId: string,
): Set<string> {
  const portfolioOf = new Map(memberships.map((m) => [m.accountId, m.portfolioId]));
  return new Set(
    accountIds.filter((id) => inView(portfolioOf.get(id), selectedPortfolioId, defaultPortfolioId)),
  );
}

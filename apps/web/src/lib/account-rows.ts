import type { AccountTagLink, PortfolioMembership } from "@folio/db";
import type { AccountRow } from "../components/account-detail-sheet";
import type { AccountHoldings, AccountListItem } from "./queries/accounts";

// 账户页那一行的合并口径:**四个来源拼成一行**。
//   · listAccounts —— 全部账户(含归档)+ 凭据投影
//   · listAccountHoldings —— 活跃账户的市值 / 上次同步 / 持仓明细(归档账户不在里面 → 那几项为空)
//   · 组合归属 —— 决定这一行属于哪个组合
//   · 标签关联 —— 这个账户已打的 Tag
//
// 从路由 loader 里搬出来的(#413)。搬的原因是四个来源现在各自是一条 react-query 查询、各自的
// 到达时刻不同,拼装得跟着数据走而不是跟着 loader 走;顺带这段纯逻辑也就能单测了。

// 归属与标签关联的形状**从 `@folio/db` 拿**,别在这儿再定义一份同名的:仓里已经有
// `PortfolioMembership` / `AccountTagLink`(隔壁 `accounts-in-view.ts` 用的就是它们),
// 两个同名不同处的类型迟早会漂移。Tag 只取渲染要的三个字段,所以这里保留一个窄形状。
interface TagRef {
  id: string;
  name: string;
  portfolioId: string;
}

export function buildAccountRows(sources: {
  accounts: readonly AccountListItem[];
  holdings: AccountHoldings;
  memberships: readonly PortfolioMembership[];
  allTags: readonly TagRef[];
  tagLinks: readonly AccountTagLink[];
}): AccountRow[] {
  const byId = new Map(sources.holdings.rows.map((r) => [r.account.id, r]));
  const portfolioOf = new Map(sources.memberships.map((m) => [m.accountId, m.portfolioId]));
  const tagsById = new Map(sources.allTags.map((tg) => [tg.id, tg]));
  // 每账户已打的 Tag(展示投影:id + 名字)。
  const tagsOfAccount = new Map<string, { id: string; name: string }[]>();
  for (const l of sources.tagLinks) {
    const tg = tagsById.get(l.tagId);
    if (!tg) continue;
    const list = tagsOfAccount.get(l.accountId) ?? [];
    list.push({ id: tg.id, name: tg.name });
    tagsOfAccount.set(l.accountId, list);
  }
  return sources.accounts.map((a) => {
    const ov = byId.get(a.id);
    return {
      id: a.id,
      label: a.label,
      connectorId: a.connectorId,
      archivedAt: a.archivedAt,
      totalUsd: ov?.totalUsd ?? 0,
      takenAt: ov?.takenAt ?? null,
      balances: ov?.balances ?? [],
      // 24h 盈亏(ADR 0040)。**三态原样透传,别 `?? null`** —— server 给归档账户的就是 `undefined`
      // (封存了,这个位置不该有这个数),压成 `null` 会让界面画出一个 `—`。
      gain24h: ov?.gain24h,
      note: ov?.note,
      needsCredentials: a.needsCredentials,
      credsSafe: a.credsSafe,
      portfolioId: portfolioOf.get(a.id) ?? "",
      tags: tagsOfAccount.get(a.id) ?? [],
    };
  });
}

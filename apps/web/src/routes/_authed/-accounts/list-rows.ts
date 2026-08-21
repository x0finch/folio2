import type { Note } from "@folio/connectors-basic";
import type { AccountTagLink, PortfolioMembership } from "@folio/db";
import type { OverviewBalance } from "../../../lib/core/account-view";
import type { AccountHoldings, AccountListItem } from "../../../lib/queries/accounts";
import type { Gain } from "../../../lib/server/portfolio/gain-24h";

interface AccountTagView {
  id: string;
  name: string;
}

export interface AccountRow {
  id: string;
  label: string;
  connectorId: AccountListItem["connectorId"];
  archivedAt: number | null;
  /** 金额查询到了才为 true。未到时 totalUsd 是占位 0,UI 必须走骨架,不能当真 0。 */
  valuesReady: boolean;
  totalUsd: number;
  takenAt: number | null;
  balances: OverviewBalance[];
  /** 24h 盈亏。`undefined` = 不该有(归档);`null` = 该有但算不出。 */
  gain24h?: Gain | null;
  note?: Note[];
  needsCredentials: boolean;
  credsSafe: Record<string, string>;
  portfolioId: string;
  tags: AccountTagView[];
}

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
  /** 没到 → 名单仍能拼出来,金额位走骨架,不把市值写成 0。 */
  holdings?: AccountHoldings;
  memberships: readonly PortfolioMembership[];
  allTags: readonly TagRef[];
  tagLinks: readonly AccountTagLink[];
}): AccountRow[] {
  const valuesReady = sources.holdings != null;
  const byId = new Map((sources.holdings?.rows ?? []).map((r) => [r.account.id, r]));
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
      valuesReady,
      totalUsd: ov?.totalUsd ?? 0,
      takenAt: ov?.takenAt ?? null,
      balances: ov?.balances ?? [],
      note: ov?.note,
      needsCredentials: a.needsCredentials,
      credsSafe: a.credsSafe,
      portfolioId: portfolioOf.get(a.id) ?? "",
      tags: tagsOfAccount.get(a.id) ?? [],
    };
  });
}

export function sortActiveAccounts<T extends { totalUsd: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.totalUsd - a.totalUsd);
}

// 分母只计活跃账户。归档有市值也不进(ADR 0039)。总计 ≤ 0 → 占比 0。
export function activeAccountsTotal(
  rows: { totalUsd: number; archivedAt: number | null }[],
): number {
  return rows.reduce((s, r) => (r.archivedAt == null ? s + r.totalUsd : s), 0);
}

export function accountShare(value: number, total: number): number {
  return total > 0 ? value / total : 0;
}

export function shareLabel(pct: number): string {
  return pct > 0 && pct < 1 ? "<1.0" : pct.toFixed(1);
}

export const STALE_SYNC_MS = 24 * 60 * 60 * 1000;

export type AccountSyncStatus = "needsCreds" | "never" | "stale" | "fresh";

export function accountSyncStatus(
  account: { needsCredentials: boolean; takenAt: number | null },
  nowMs: number,
): AccountSyncStatus {
  if (account.needsCredentials) return "needsCreds";
  if (account.takenAt == null) return "never";
  return nowMs - account.takenAt > STALE_SYNC_MS ? "stale" : "fresh";
}

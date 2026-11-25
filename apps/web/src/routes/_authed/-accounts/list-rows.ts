import type { Note } from "@folio/connectors-basic";
import type { AccountTagLink } from "@folio/db";
import type { OverviewBalance } from "@/lib/core/account-view";
import type { Gain } from "@/lib/core/portfolio";
import type { AccountHoldings, AccountListItem } from "@/lib/queries/accounts";

interface AccountTagView {
  id: string;
  name: string;
}

export interface AccountRow {
  id: string;
  label: string;
  connectorId: AccountListItem["connectorId"];
  archivedAt: number | null;
  /** When false, totalUsd is a placeholder 0: render a skeleton, not a real zero. */
  valuesReady: boolean;
  totalUsd: number;
  takenAt: number | null;
  balances: OverviewBalance[];
  /** `undefined` = shouldn't exist (archived); `null` = should exist but couldn't be computed. */
  gain24h?: Gain | null;
  note?: Note[];
  needsCredentials: boolean;
  missingCreds: readonly string[];
  credsSafe: Record<string, string>;
  portfolioId: string;
  tags: AccountTagView[];
}

// Each source is a separate query arriving at its own time, so assembly follows the data.
// Tags: a narrow shape with only the fields rendering needs.
interface TagRef {
  id: string;
  name: string;
  portfolioId: string;
}

export function buildAccountRows(sources: {
  accounts: readonly AccountListItem[];
  /** Missing → rows still build; amounts render as skeletons rather than 0. */
  holdings?: AccountHoldings;
  allTags: readonly TagRef[];
  tagLinks: readonly AccountTagLink[];
}): AccountRow[] {
  const valuesReady = sources.holdings != null;
  const byId = new Map((sources.holdings?.rows ?? []).map((r) => [r.account.id, r]));
  const tagsById = new Map(sources.allTags.map((tg) => [tg.id, tg]));
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
      // Accounts missing credentials show no header delta; their holdings still carry their own.
      gain24h: a.needsCredentials ? undefined : ov?.gain24h,
      note: ov?.note,
      needsCredentials: a.needsCredentials,
      missingCreds: a.missingCreds,
      credsSafe: a.credsSafe,
      portfolioId: a.portfolioId,
      tags: tagsOfAccount.get(a.id) ?? [],
    };
  });
}

export function sortActiveAccounts<T extends { totalUsd: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.totalUsd - a.totalUsd);
}

// Archived accounts are excluded from the denominator even when they have value.
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

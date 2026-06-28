// 纯逻辑(无 server-only import → 可单测)。把账户净值按组聚合成展示视图。
// 不变量(见 @folio/core 净值不变量的组层推论):
//   · 一个账户属于 N 个组 → 它计入【每个】组的小计(符合预期);
//   · ungrouped = 不属任何组的账户;
//   · 组合总净值【不】由各组小计求和得来(多组账户会重复)——总额另用 getMyOverview.totalUsd
//     (按账户去重)。本函数只产分组小计,不产总额。

export interface GroupInfo {
  id: string;
  name: string;
  sortOrder: number;
}
export interface MembershipInfo {
  accountId: string;
  groupId: string;
}
export interface AccountTotal {
  account: { id: string; label: string };
  totalUsd: number;
}

export interface GroupedAccount {
  id: string;
  label: string;
  totalUsd: number;
}
export interface GroupSection {
  group: GroupInfo;
  subtotalUsd: number;
  accounts: GroupedAccount[];
}
export interface UngroupedSection {
  subtotalUsd: number;
  accounts: GroupedAccount[];
}
export interface GroupedView {
  groups: GroupSection[];
  ungrouped: UngroupedSection;
}

export function toGroupedView(
  rows: AccountTotal[],
  groups: GroupInfo[],
  memberships: MembershipInfo[],
): GroupedView {
  // accountId → 它所属的 groupId 集合
  const groupsOfAccount = new Map<string, Set<string>>();
  for (const m of memberships) {
    const set = groupsOfAccount.get(m.accountId) ?? new Set<string>();
    set.add(m.groupId);
    groupsOfAccount.set(m.accountId, set);
  }

  const toRow = (r: AccountTotal): GroupedAccount => ({
    id: r.account.id,
    label: r.account.label,
    totalUsd: r.totalUsd,
  });

  // 组按 sortOrder、再按 name 稳定排序。
  const orderedGroups = [...groups].sort(
    (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
  );
  const sections: GroupSection[] = orderedGroups.map((group) => {
    const accounts = rows
      .filter((r) => groupsOfAccount.get(r.account.id)?.has(group.id))
      .map(toRow);
    const subtotalUsd = accounts.reduce((s, a) => s + a.totalUsd, 0);
    return { group, subtotalUsd, accounts };
  });

  const ungroupedAccounts = rows
    .filter((r) => !(groupsOfAccount.get(r.account.id)?.size ?? 0))
    .map(toRow);
  const ungrouped: UngroupedSection = {
    subtotalUsd: ungroupedAccounts.reduce((s, a) => s + a.totalUsd, 0),
    accounts: ungroupedAccounts,
  };

  return { groups: sections, ungrouped };
}

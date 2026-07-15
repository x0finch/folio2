import type { HoldingSource } from "./aggregate";

// 详情抽屉「来源」区的两种转置视图(纯逻辑,可单测):
//   · byPlatform:按平台/链聚合 —— 看这个币散在哪些链/场馆,每条列它涉及几个账户。
//   · byAccount :按账户聚合 —— 看这个币散在哪些账户,每条列该账户跨了几处平台。
// 两者对称:一个的主副维度是另一个的副主维度。i18n 留给组件(本层只出 count/single 原料)。

export interface SourceGroupAvatar {
  logo?: string;
  name: string; // 缺 logo 时回退首字母 + title
}

export interface SourceGroup {
  key: string;
  avatars: SourceGroupAvatar[]; // 左侧头像:1 个 = 单 logo,多个 = 叠标
  primary: string; // 主行(平台名 / 账户名)
  count: number; // 副维度基数(账户数 / 平台数);=1 时用 single 显具体名
  single: string | null; // count===1 时的具体名(账户名 / 平台名),否则 null
  amount: number; // 组内数量之和(组统一单位)
  value: number; // 组内 USD 之和(占比与排序按它)
}

export function groupByPlatform(sources: readonly HoldingSource[]): SourceGroup[] {
  const m = new Map<
    string,
    {
      name: string;
      logo?: string;
      accounts: Set<string>;
      lastAccount: string;
      amount: number;
      value: number;
    }
  >();
  for (const s of sources) {
    let g = m.get(s.platform.id);
    if (!g) {
      g = {
        name: s.platform.name,
        logo: s.platform.logo,
        accounts: new Set(),
        lastAccount: s.account.label,
        amount: 0,
        value: 0,
      };
      m.set(s.platform.id, g);
    }
    g.amount += s.amount;
    g.value += s.value;
    g.accounts.add(s.account.id);
    g.lastAccount = s.account.label;
  }
  return [...m.entries()]
    .map(([key, g]) => ({
      key,
      avatars: [{ logo: g.logo, name: g.name }],
      primary: g.name,
      count: g.accounts.size,
      single: g.accounts.size === 1 ? g.lastAccount : null,
      amount: g.amount,
      value: g.value,
    }))
    .sort((a, b) => b.value - a.value);
}

export function groupByAccount(sources: readonly HoldingSource[]): SourceGroup[] {
  const m = new Map<
    string,
    {
      label: string;
      platforms: Map<string, { name: string; logo?: string }>;
      amount: number;
      value: number;
    }
  >();
  for (const s of sources) {
    let g = m.get(s.account.id);
    if (!g) {
      g = { label: s.account.label, platforms: new Map(), amount: 0, value: 0 };
      m.set(s.account.id, g);
    }
    g.amount += s.amount;
    g.value += s.value;
    if (!g.platforms.has(s.platform.id)) {
      g.platforms.set(s.platform.id, { name: s.platform.name, logo: s.platform.logo });
    }
  }
  return [...m.entries()]
    .map(([key, g]) => {
      const plats = [...g.platforms.entries()];
      return {
        key,
        avatars: plats.map(([, p]) => ({ logo: p.logo, name: p.name })),
        primary: g.label,
        count: plats.length,
        single: plats.length === 1 ? plats[0][1].name : null,
        amount: g.amount,
        value: g.value,
      };
    })
    .sort((a, b) => b.value - a.value);
}

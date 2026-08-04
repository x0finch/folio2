import type { HoldingSource } from "./aggregate";

// 详情抽屉「来源」区的两种转置视图(纯逻辑,可单测):
//   · byPlatform:按平台/链聚合 —— 看这个币散在哪些链/场馆,每条列它涉及几个账户。
//   · byAccount :按账户聚合 —— 看这个币散在哪些账户,每条列该账户跨了几处平台。
// 两者对称:一个的主副维度是另一个的副主维度。i18n 留给组件(本层只出 count/single 原料)。

interface SourceGroupAvatar {
  logo?: string;
  name: string; // 缺 logo 时回退首字母 + title
}

export interface SourceGroup {
  key: string;
  avatars: SourceGroupAvatar[]; // 左侧头像:1 个 = 单 logo,多个 = 叠标
  primary: string; // 主行(平台名 / 账户名)
  count: number; // 副维度基数(账户数 / 平台数);=1 时用 single 显具体名
  single: string | null; // count===1 时的具体名(账户名 / 平台名),否则 null
  // 平台视图副行点名用(#351 ③):组内**按 value 倒序**的前几个账户 —— 组件按 collapseToSlots
  // 渲染成 `@a` / `@a @b @c` / `@a @b +n`,不再只报「{n} accounts」计数。带足 TOP_ACCOUNTS 个候选
  // (= 折叠阈值),这样「恰好 3 个」也全显得出来;超过阈值时组件只用前 2 个,余量由 count 算。
  // 带 id 而非只带 label:账户名可以重名,渲染要一个稳定唯一的 key。
  // 账户视图不点名(副维度是平台,已有 avatars 表达),留空数组。
  topAccounts: { id: string; label: string }[];
  amount: number; // 组内数量之和(组统一单位)
  value: number; // 组内 USD 之和(占比与排序按它)
}

// 副行携带的候选账户数 = 折叠阈值(见 ACCOUNT_SLOTS):≤ 这个数时全显,故得带满。
const TOP_NAMES = 3;

export function groupByPlatform(sources: readonly HoldingSource[]): SourceGroup[] {
  const m = new Map<
    string,
    {
      name: string;
      logo?: string;
      // 按账户累计组内 value —— 副行点名要「组内最大的两个账户」,光有账户数不够(#351 ③)。
      accounts: Map<string, { id: string; label: string; value: number }>;
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
        accounts: new Map(),
        amount: 0,
        value: 0,
      };
      m.set(s.platform.id, g);
    }
    g.amount += s.amount;
    g.value += s.value;
    const a = g.accounts.get(s.account.id);
    if (a) a.value += s.value;
    else g.accounts.set(s.account.id, { id: s.account.id, label: s.account.label, value: s.value });
  }
  return [...m.entries()]
    .map(([key, g]) => {
      const byValue = [...g.accounts.values()].sort((a, b) => b.value - a.value);
      const first = byValue[0];
      return {
        key,
        avatars: [{ logo: g.logo, name: g.name }],
        primary: g.name,
        count: byValue.length,
        single: byValue.length === 1 ? (first?.label ?? null) : null,
        topAccounts: byValue.slice(0, TOP_NAMES).map((a) => ({ id: a.id, label: a.label })),

        amount: g.amount,
        value: g.value,
      };
    })
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
        topAccounts: [], // 账户视图副维度是平台,由 avatars 表达,不点名
        amount: g.amount,
        value: g.value,
      };
    })
    .sort((a, b) => b.value - a.value);
}

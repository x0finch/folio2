import { buildStack, type StackItem } from "@/components/avatar-stack";
import type { HoldingSource } from "@/lib/core/portfolio";

// The two transposed views of the drawer's "sources" area (pure logic): byPlatform (which chains /
// venues hold this token, with account counts) and byAccount (which accounts, with platform counts).
// i18n is left to the component.

export interface SourceGroup {
  key: string;
  // Left avatars: one = a single logo, several = a stack.
  avatars: StackItem[];
  primary: string; // main row (platform / account name)
  count: number; // secondary-dimension cardinality; when 1, `single` names it
  single: string | null; // the specific name when count === 1, else null
  // Platform view only: the top ACCOUNT_SLOTS accounts by value, rendered via collapseToSlots
  // (`@a` / `@a @b @c` / `@a @b +n`). Carries a full threshold's worth of candidates so exactly 3
  // all show; carries id because account names can repeat. Empty in the account view.
  topAccounts: { id: string; label: string }[];
  amount: number; // sum of amounts in the group (one unit per group)
  value: number; // sum of USD in the group (share and sort key)
}

// Fold threshold for the platform sub-row: <= it shows all, above shows max-1 + `+N`. The carried
// candidate count must equal it (else the exact-threshold case silently drops one), so both share this constant.
export const ACCOUNT_SLOTS = 3;

export function groupByPlatform(sources: readonly HoldingSource[]): SourceGroup[] {
  const m = new Map<
    string,
    {
      name: string;
      logo?: string;
      // Accumulated per account: the sub-row names the group's largest accounts.
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
        // Platform view is always one avatar, so there's no ordering question (skips buildStack).
        avatars: [{ logo: g.logo, name: g.name, k: key }],
        primary: g.name,
        count: byValue.length,
        single: byValue.length === 1 ? (first?.label ?? null) : null,
        topAccounts: byValue.slice(0, ACCOUNT_SLOTS).map((a) => ({ id: a.id, label: a.label })),
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
      // Share of each platform in this account; avatars sort by it descending (same rule as the account-row stack, see `buildStack`).
      platforms: Map<string, { name: string; logo?: string; value: number }>;
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
    const p = g.platforms.get(s.platform.id);
    if (p) p.value += s.value;
    else {
      g.platforms.set(s.platform.id, {
        name: s.platform.name,
        logo: s.platform.logo,
        value: s.value,
      });
    }
  }
  return [...m.entries()]
    .map(([key, g]) => {
      const plats = [...g.platforms.entries()];
      return {
        key,
        // Sort only, no dust drop (`dust: 0`): the avatar count must match "across n platforms" (see buildStack).
        avatars: buildStack(
          plats.map(([id, p]) => ({ k: id, name: p.name, logo: p.logo, magnitude: p.value })),
          0,
        ),
        primary: g.label,
        count: plats.length,
        single: plats.length === 1 ? plats[0][1].name : null,
        topAccounts: [], // the account view's secondary dimension is platforms, shown by avatars
        amount: g.amount,
        value: g.value,
      };
    })
    .sort((a, b) => b.value - a.value);
}

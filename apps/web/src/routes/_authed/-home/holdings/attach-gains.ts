import type { DefiGroup } from "@/lib/core/account-view";
import { defiGainKey } from "@/lib/core/account-view";
import type { Holding } from "@/lib/server/portfolio/aggregate";

/** 独立盈亏载荷里用来拼回总览的那两张表(组合级 `portfolio` 不在这里,hero 直接读)。 */
export type GainMaps = {
  holdings: Record<string, Holding["gain24h"]>;
  defi: Record<string, DefiGroup["gain24h"]>;
};

/** 把按 holding.key 下发的盈亏贴回各行。没到 → 原样(字段缺席);失败 / 缺键 → null(算不出)。 */
export function attachHoldingGains<H extends { key: string }>(
  holdings: readonly H[],
  maps: GainMaps | undefined,
  failed: boolean,
): H[] {
  if (!failed && maps == null) return holdings as H[];
  return holdings.map((h) => ({
    ...h,
    gain24h: failed ? null : (maps?.holdings[h.key] ?? null),
  }));
}

/** 把按 `账户|协议` 下发的盈亏贴回各账户 DeFi 组,再交给 mergeDefiGroups 跨账户加总。 */
export function attachDefiGains<S extends { account: { id: string }; defi: readonly DefiGroup[] }>(
  sections: readonly S[],
  maps: GainMaps | undefined,
  failed: boolean,
): S[] {
  if (!failed && maps == null) return sections as S[];
  return sections.map((s) => ({
    ...s,
    defi: s.defi.map((g) => ({
      ...g,
      gain24h: failed ? null : (maps?.defi[defiGainKey(s.account.id, g.protocol)] ?? null),
    })),
  }));
}

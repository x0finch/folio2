/** 贴回用的增量形状:金额 + 百分比。分段解释只在算的那一侧,贴回不需要。 */
type Delta = { amount: number; pct: number | null };

/** 独立盈亏载荷:账户头按账户 id,抽屉现货行按余额行 id。 */
export type AccountGainMaps = {
  accounts: Record<string, Delta | null>;
  balances: Record<string, Delta | null>;
};

type Row = {
  id: string;
  archivedAt: number | null;
  needsCredentials: boolean;
  gain24h?: Delta | null;
  balances: { id: string; tokenId?: string | null; gain24h?: Delta | null }[];
};

/** 把按账户 / 余额行下发的盈亏贴回各行。没到 → 原样(字段缺席);失败 / 缺键 → null(算不出)。
 *  归档行不贴(这个位置不该有);缺凭据账户头不贴,现货行仍贴(抽屉里还能看见导入快照)。 */
export function attachAccountGains<R extends Row>(
  rows: readonly R[],
  maps: AccountGainMaps | undefined,
  failed: boolean,
): R[] {
  if (!failed && maps == null) return rows as R[];
  return rows.map((r) => {
    const sealed = r.archivedAt != null;
    return {
      ...r,
      gain24h:
        sealed || r.needsCredentials ? undefined : failed ? null : (maps?.accounts[r.id] ?? null),
      balances: r.balances.map((b) => ({
        ...b,
        gain24h:
          sealed || b.tokenId == null ? undefined : failed ? null : (maps?.balances[b.id] ?? null),
      })),
    };
  }) as R[];
}

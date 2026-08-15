import type { Gain } from "./gain-24h";

// 24h 盈亏单独一条读之后(#488),把回来的映射贴回各行 —— 纯函数,可脱离组件单测。
//
// **为什么要有这一步**:总览与盈亏是两个请求,谁先到不一定。列表要能在盈亏还没到时先画出来
// (那时盈亏位是骨架),盈亏到了再贴上去。贴合的键必须两边一致,所以键的定义只有这一处。

/** DeFi 协议行的索引键。协议行没有 token_id,只能按 (账户 × 协议) 定位。 */
export const defiGainKey = (accountId: string, protocol: string) => `${accountId}|${protocol}`;

/**
 * DeFi 协议行的盈亏。**不是 `Gain`**:协议行没有「数量固定的段」可分,整条线就是两张照片相减
 * (ADR 0040 的已知妥协),所以没有 segments;换来的是一个分母 —— 跨账户合并协议组时要用
 * Σ金额 ÷ Σ总敞口 重算百分比,而从 pct 反推分母在 pct 为 0 时推不出来。
 */
export interface DefiGain {
  amount: number;
  pct: number | null;
  grossBasis?: number;
}

export interface PortfolioGains {
  portfolio: Gain | null;
  byKey: Record<string, Gain | null>;
  defiByKey: Record<string, DefiGain | null>;
}

/**
 * 把按持仓键索引的盈亏贴回各行。
 *
 * **盈亏还没到时,字段留 `undefined` 而不是 `null`** —— 全站三态口径(见 lib/delta-display):
 * `undefined` = 这行本来就不该有这个数 / 还没到,`null` = 该有但算不出。界面据此分别显示骨架与
 * 破折号,两者混掉就等于把「还在算」说成「算不出来」。
 */
export function attachHoldingGains<T extends { key: string }>(
  holdings: readonly T[],
  gains: PortfolioGains | undefined,
): (T & { gain24h?: Gain | null })[] {
  if (!gains) return holdings.map((h) => ({ ...h }));
  return holdings.map((h) => ({ ...h, gain24h: gains.byKey[h.key] ?? null }));
}

/** 同上,贴回每账户分区里的 DeFi 协议行(合并协议组之前贴,合并要用到各行的分母)。 */
export function attachSectionGains<
  G extends { protocol: string },
  S extends { account: { id: string }; defi: G[] },
>(
  sections: readonly S[],
  gains: PortfolioGains | undefined,
): (Omit<S, "defi"> & { defi: (G & { gain24h?: DefiGain | null })[] })[] {
  if (!gains) return sections.map((s) => ({ ...s }));
  return sections.map((s) => ({
    ...s,
    defi: s.defi.map((g) => ({
      ...g,
      gain24h: gains.defiByKey[defiGainKey(s.account.id, g.protocol)] ?? null,
    })),
  }));
}

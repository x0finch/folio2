// 净值 hero 的三指标读模型(纯 —— 可脱离组件单测)。
// best/worst = 24h 涨跌最高/最低的持仓;stableShare = 稳定币市值占比。

// 稳定币判定的【临时固定清单】(#102):按 CGK 分类的动态 facet(ADR 0016 / #99)落地前先用这份
// 常见稳定币 symbol 兜底。#99 上线后应换成 tokens.is_stablecoin,并删掉此清单。
export const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "USDC.E",
  "DAI",
  "USDS",
  "USDE",
  "TUSD",
  "USDD",
  "FDUSD",
  "PYUSD",
  "BUSD",
  "GUSD",
  "USDP",
  "FRAX",
  "LUSD",
  "USD1",
  "USDL",
  "EURC",
  "EURT",
  "EURS",
]);

export function isStablecoin(symbol: string): boolean {
  return STABLECOIN_SYMBOLS.has(symbol.trim().toUpperCase());
}

export interface HoldingLike {
  token: { symbol: string };
  totalValue: number;
  change24h?: number;
}

export interface HeroMetrics {
  /** 24h 涨幅最高的持仓(仅计有 change24h 的行);无则 null。 */
  best: { symbol: string; change24h: number } | null;
  /** 24h 跌幅最深(change24h 最低)的持仓;无则 null。 */
  worst: { symbol: string; change24h: number } | null;
  /** 稳定币市值 / 组合总额(0..1);总额 ≤ 0 时 null。 */
  stableShare: number | null;
}

export function deriveHeroMetrics(
  holdings: readonly HoldingLike[],
  totalValue: number,
): HeroMetrics {
  let best: HeroMetrics["best"] = null;
  let worst: HeroMetrics["worst"] = null;
  let stableSum = 0;
  for (const h of holdings) {
    if (isStablecoin(h.token.symbol)) stableSum += h.totalValue;
    if (h.change24h == null) continue;
    const entry = { symbol: h.token.symbol, change24h: h.change24h };
    // 严格大于/小于 → 并列时保留先出现者(与设计的排序取首一致)。
    if (best == null || entry.change24h > best.change24h) best = entry;
    if (worst == null || entry.change24h < worst.change24h) worst = entry;
  }
  return {
    best,
    worst,
    // clamp ≤ 1:稳定币市值可能 > 组合净值(perp/保证金亏损压低净值,或 defi 不计入 holdings),
    // 不 clamp 会渲染出 >100% 的占比。
    stableShare: totalValue > 0 ? Math.min(1, stableSum / totalValue) : null,
  };
}

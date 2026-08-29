// 净值 hero 的三指标读模型(纯 —— 可脱离组件单测)。
// best/worst = 24h 涨跌最高/最低的持仓;stableShare = 稳定币市值占比。

// 稳定币判定的【临时固定清单】(#102):按 CGK 分类的动态 facet(ADR 0016 / #99)落地前先用这份
// 常见稳定币 symbol 兜底。#99 上线后应换成 tokens.is_stablecoin,并删掉此清单。
const STABLECOIN_SYMBOLS: ReadonlySet<string> = new Set([
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
  // isFiat:法币身份(ADR 0025),由 fiat 命名者的 ref 经 fiatCodeOf 推出、不看裸 symbol —— 由上游
  // (aggregate → overview-model)填好。稳定口径把所有法币都算稳定(现金类、非加密波动)。
  token: { symbol: string; isFiat?: boolean };
  totalValue: number;
  // 24h 盈亏(ADR 0050:两端相减),由 server 算好。null = 算不出。
  gain24h?: { amount: number; pct: number | null } | null;
}

export interface HeroMetrics {
  /** 今天**赚得最多**的持仓(按 24h 盈亏金额);无可算的行则 null。 */
  best: { symbol: string; amount: number } | null;
  /** 今天**赚得最少 / 亏得最多**的持仓;无可算的行则 null。 */
  worst: { symbol: string; amount: number } | null;
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
    // 稳定 = 法币(身份驱动,USD 与非 USD 法币皆是)‖ 稳定币 symbol 表(#102 临时清单)。
    if (h.token.isFiat || isStablecoin(h.token.symbol)) stableSum += h.totalValue;
    // **按盈亏金额取,不按涨跌幅**(ADR 0050)。以前这里只看涨跌幅、完全不看持有多少,于是这两个
    // 格子永远被小仓位的暴涨币占据 —— 持有 500 块的币涨 30%,就把最大的仓位顶掉了。它回答的是
    // 「哪个币涨得最多」,而人想知道的是「今天谁让我赚得最多」。
    if (h.gain24h == null) continue; // 算不出的行不参与择取
    const entry = { symbol: h.token.symbol, amount: h.gain24h.amount };
    // 严格大于/小于 → 并列时保留先出现者(与设计的排序取首一致)。
    if (best == null || entry.amount > best.amount) best = entry;
    if (worst == null || entry.amount < worst.amount) worst = entry;
  }
  return {
    best,
    worst,
    // clamp ≤ 1:稳定币市值可能 > 组合净值(perp/保证金亏损压低净值,或 defi 不计入 holdings),
    // 不 clamp 会渲染出 >100% 的占比。
    stableShare: totalValue > 0 ? Math.min(1, stableSum / totalValue) : null,
  };
}

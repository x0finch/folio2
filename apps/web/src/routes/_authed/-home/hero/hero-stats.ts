// Read model for the hero's three metrics (pure, unit-testable): best/worst = highest/lowest 24h
// PnL holdings, stableShare = stablecoin share of value.

// Temporary fixed stablecoin symbol list.
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
  // isFiat comes from the fiat namer ref via fiatCodeOf, never the bare symbol; stable counts all fiat.
  token: { symbol: string; isFiat?: boolean };
  totalValue: number;
  // 24h PnL computed server-side from snapshot history / ledger segments; null = not computable.
  gain24h?: { amount: number; pct: number | null } | null;
}

export interface HeroMetrics {
  /** Today's biggest gainer by 24h PnL amount; null when no row is computable. */
  best: { symbol: string; amount: number } | null;
  /** Today's smallest gain / biggest loser; null when no row is computable. */
  worst: { symbol: string; amount: number } | null;
  /** Stablecoin value / portfolio total (0..1); null when the total is <= 0. */
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
    // Stable = fiat (identity-driven) or a listed stablecoin symbol.
    if (h.token.isFiat || isStablecoin(h.token.symbol)) stableSum += h.totalValue;
    // By PnL amount, not percent: percent let tiny positions with big moves dominate the slots.
    if (h.gain24h == null) continue; // not computable: skip
    const entry = { symbol: h.token.symbol, amount: h.gain24h.amount };
    // Strict comparison: ties keep the first seen.
    if (best == null || entry.amount > best.amount) best = entry;
    if (worst == null || entry.amount < worst.amount) worst = entry;
  }
  return {
    best,
    worst,
    // Clamp to <= 1: stablecoin value can exceed net worth (perp margin losses, or DeFi not in holdings).
    stableShare: totalValue > 0 ? Math.min(1, stableSum / totalValue) : null,
  };
}

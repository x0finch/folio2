import { describe, expect, it } from "vitest";
import {
  deriveHeroMetrics,
  type HoldingLike,
  isStablecoin,
} from "@/routes/_authed/-home/hero/hero-stats";

// gain: today's P&L amount for the holding. Omitted → not computable, excluded from best/worst.
const h = (symbol: string, totalValue: number, gain?: number, pct?: number): HoldingLike => ({
  token: { symbol },
  totalValue,
  ...(gain === undefined ? {} : { gain24h: { amount: gain, pct: pct ?? null } }),
});

// Fiat rows: identity-driven (isFiat); symbol is display only and doesn't decide "stable".
const fiat = (symbol: string, totalValue: number): HoldingLike => ({
  token: { symbol, isFiat: true },
  totalValue,
});

describe("isStablecoin", () => {
  it("matches known stablecoins case-insensitively", () => {
    expect(isStablecoin("USDC")).toBe(true);
    expect(isStablecoin("usdt")).toBe(true);
    expect(isStablecoin(" Dai ")).toBe(true);
    expect(isStablecoin("USDC.e")).toBe(true);
  });
  it("rejects non-stablecoins", () => {
    expect(isStablecoin("BTC")).toBe(false);
    expect(isStablecoin("ETH")).toBe(false);
  });
});

describe("deriveHeroMetrics", () => {
  it("picks by P&L amount, not by percent change", () => {
    const m = deriveHeroMetrics([h("BTC", 100, 3.2), h("ETH", 50, -1.5), h("SOL", 20, 8.1)], 170);
    expect(m.best).toEqual({ symbol: "SOL", amount: 8.1 });
    expect(m.worst).toEqual({ symbol: "ETH", amount: -1.5 });
  });

  it("a $500 coin up 30% doesn't beat a $100k position up 2%", () => {
    // By percent alone, small coins would always win both slots regardless of position size.
    const shitcoin = h("SHIT", 500, 150, 30); // $500 up 30% → +150
    const btc = h("BTC", 100_000, 2_000, 2); // $100k up 2% → +2,000
    const m = deriveHeroMetrics([shitcoin, btc], 100_500);
    expect(m.best?.symbol).toBe("BTC");
    // By percent, best would be the $500 coin
    expect(m.best?.symbol).not.toBe("SHIT");
  });

  it("rows without computable P&L are excluded", () => {
    const m = deriveHeroMetrics([h("BTC", 100), h("ETH", 50, -2)], 150);
    expect(m.best).toEqual({ symbol: "ETH", amount: -2 });
    expect(m.worst).toEqual({ symbol: "ETH", amount: -2 });
  });

  it("none computable → best/worst both null (UI renders `—`)", () => {
    const m = deriveHeroMetrics([h("BTC", 100), h("USDC", 50)], 150);
    expect(m.best).toBeNull();
    expect(m.worst).toBeNull();
  });

  it("rows with zero P&L still count — that's a real result, not missing data", () => {
    const m = deriveHeroMetrics([h("BTC", 100, 0)], 100);
    expect(m.best).toEqual({ symbol: "BTC", amount: 0 });
  });

  it("ties keep the first occurrence", () => {
    const m = deriveHeroMetrics([h("AAA", 10, 5), h("BBB", 10, 5)], 20);
    expect(m.best?.symbol).toBe("AAA");
    expect(m.worst?.symbol).toBe("AAA");
  });

  it("sums stablecoin value as a share of total", () => {
    const m = deriveHeroMetrics([h("BTC", 60, 1), h("USDC", 30), h("USDT", 10)], 100);
    expect(m.stableShare).toBeCloseTo(0.4);
  });

  it("stableShare is null when total is zero", () => {
    expect(deriveHeroMetrics([], 0).stableShare).toBeNull();
  });

  // All fiat (by identity) counts as stable — USD and non-USD — whether or not its symbol is in the table.
  it("counts fiat holdings as stable (USD and non-USD alike)", () => {
    const m = deriveHeroMetrics([h("BTC", 50, 1), fiat("USD", 30), fiat("EUR", 20)], 100);
    // BTC not stable; USD + EUR fiat count → 0.5.
    expect(m.stableShare).toBeCloseTo(0.5);
  });

  it("fiat identity drives stable, not the bare symbol", () => {
    // Symbol "USD" without isFiat → not stable (no symbol-table hit); only isFiat counts.
    expect(deriveHeroMetrics([h("USD", 100)], 100).stableShare).toBeCloseTo(0);
    expect(deriveHeroMetrics([fiat("USD", 100)], 100).stableShare).toBeCloseTo(1);
  });

  it("fiat and stablecoin-symbol holdings both count (no double path conflict)", () => {
    const m = deriveHeroMetrics([h("BTC", 50, 1), h("USDC", 30), fiat("JPY", 20)], 100);
    // USDC (symbol table) + JPY (fiat identity) = 0.5.
    expect(m.stableShare).toBeCloseTo(0.5);
  });

  it("clamps stableShare to 1 when stablecoin value exceeds net worth", () => {
    // Stablecoins 100 but net worth only 50 (e.g. perp losses) → unclamped would be 2.0 (200%).
    const m = deriveHeroMetrics([h("USDC", 100)], 50);
    expect(m.stableShare).toBe(1);
  });
});

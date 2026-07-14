import { describe, expect, it } from "vitest";
import { deriveHeroMetrics, type HoldingLike, isStablecoin } from "../src/lib/hero-stats";

const h = (symbol: string, totalValue: number, change24h?: number): HoldingLike => ({
  token: { symbol },
  totalValue,
  ...(change24h === undefined ? {} : { change24h }),
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
  it("picks best (highest 24h) and worst (lowest 24h)", () => {
    const m = deriveHeroMetrics([h("BTC", 100, 3.2), h("ETH", 50, -1.5), h("SOL", 20, 8.1)], 170);
    expect(m.best).toEqual({ symbol: "SOL", change24h: 8.1 });
    expect(m.worst).toEqual({ symbol: "ETH", change24h: -1.5 });
  });

  it("ignores holdings without a 24h change for best/worst", () => {
    const m = deriveHeroMetrics([h("BTC", 100), h("ETH", 50, -2)], 150);
    expect(m.best).toEqual({ symbol: "ETH", change24h: -2 });
    expect(m.worst).toEqual({ symbol: "ETH", change24h: -2 });
  });

  it("returns null best/worst when no holding has a 24h change", () => {
    const m = deriveHeroMetrics([h("BTC", 100), h("USDC", 50)], 150);
    expect(m.best).toBeNull();
    expect(m.worst).toBeNull();
  });

  it("keeps the first holding on a tie", () => {
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

  it("clamps stableShare to 1 when stablecoin value exceeds net worth", () => {
    // 稳定币市值 100,但组合净值仅 50(如 perp 亏损压低)→ 不 clamp 会得 2.0(200%)。
    const m = deriveHeroMetrics([h("USDC", 100)], 50);
    expect(m.stableShare).toBe(1);
  });
});

import { describe, expect, it } from "vitest";
import { deriveHeroMetrics, type HoldingLike, isStablecoin } from "../src/lib/hero-stats";

// gain:该持仓今天赚 / 亏的**金额**(ADR 0040)。省略 → 算不出,不参与 best/worst 择取。
const h = (symbol: string, totalValue: number, gain?: number, pct?: number): HoldingLike => ({
  token: { symbol },
  totalValue,
  ...(gain === undefined ? {} : { gain24h: { amount: gain, pct: pct ?? null } }),
});

// 法币行:身份驱动(isFiat),symbol 只是展示 —— 稳定判定不看它。
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
  it("按赚 / 亏的金额取,不按涨跌幅", () => {
    const m = deriveHeroMetrics([h("BTC", 100, 3.2), h("ETH", 50, -1.5), h("SOL", 20, 8.1)], 170);
    expect(m.best).toEqual({ symbol: "SOL", amount: 8.1 });
    expect(m.worst).toEqual({ symbol: "ETH", amount: -1.5 });
  });

  it("持有 500 块涨 30% 的小币,不会顶掉持有 10 万涨 2% 的大仓位", () => {
    // 这正是改口径要修的那个症状:以前只看涨跌幅、完全不看你持有多少,于是这两格永远被小币刷屏。
    const shitcoin = h("SHIT", 500, 150, 30); // 500 块涨 30% → 赚 150
    const btc = h("BTC", 100_000, 2_000, 2); // 10 万涨 2% → 赚 2,000
    const m = deriveHeroMetrics([shitcoin, btc], 100_500);
    expect(m.best?.symbol).toBe("BTC");
    // 而按涨跌幅取的话,best 会是那个 500 块的币
    expect(m.best?.symbol).not.toBe("SHIT");
  });

  it("算不出盈亏的行不参与择取", () => {
    const m = deriveHeroMetrics([h("BTC", 100), h("ETH", 50, -2)], 150);
    expect(m.best).toEqual({ symbol: "ETH", amount: -2 });
    expect(m.worst).toEqual({ symbol: "ETH", amount: -2 });
  });

  it("一行都算不出 → best/worst 皆 null(界面渲染 `—`)", () => {
    const m = deriveHeroMetrics([h("BTC", 100), h("USDC", 50)], 150);
    expect(m.best).toBeNull();
    expect(m.worst).toBeNull();
  });

  it("盈亏为 0 的行仍然参与 —— 那是一条真实结论,不是缺数据", () => {
    const m = deriveHeroMetrics([h("BTC", 100, 0)], 100);
    expect(m.best).toEqual({ symbol: "BTC", amount: 0 });
  });

  it("并列时保留先出现者", () => {
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

  // #271:所有法币(身份驱动)都算稳定 —— USD 与非 USD 皆是,不管 symbol 在不在稳定币表里。
  it("counts fiat holdings as stable (USD and non-USD alike)", () => {
    const m = deriveHeroMetrics([h("BTC", 50, 1), fiat("USD", 30), fiat("EUR", 20)], 100);
    // BTC 非稳定;USD + EUR 两笔法币计入 → 0.5。
    expect(m.stableShare).toBeCloseTo(0.5);
  });

  it("fiat identity drives stable, not the bare symbol", () => {
    // symbol 恰好叫 "USD" 但 isFiat 未置 → 不算稳定(不撞 symbol 表);置 isFiat 才算。
    expect(deriveHeroMetrics([h("USD", 100)], 100).stableShare).toBeCloseTo(0);
    expect(deriveHeroMetrics([fiat("USD", 100)], 100).stableShare).toBeCloseTo(1);
  });

  it("fiat and stablecoin-symbol holdings both count (no double path conflict)", () => {
    const m = deriveHeroMetrics([h("BTC", 50, 1), h("USDC", 30), fiat("JPY", 20)], 100);
    // USDC(symbol 表)+ JPY(法币身份)= 0.5。
    expect(m.stableShare).toBeCloseTo(0.5);
  });

  it("clamps stableShare to 1 when stablecoin value exceeds net worth", () => {
    // 稳定币市值 100,但组合净值仅 50(如 perp 亏损压低)→ 不 clamp 会得 2.0(200%)。
    const m = deriveHeroMetrics([h("USDC", 100)], 50);
    expect(m.stableShare).toBe(1);
  });
});

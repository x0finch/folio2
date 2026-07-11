import { describe, expect, it } from "vitest";
import { type OverviewBalance, toAccountSections } from "../src/lib/account-view";

const b = (over: Partial<OverviewBalance>): OverviewBalance => ({
  id: "x",
  symbol: "X",
  amount: 1,
  usdValue: 0,
  kind: "spot",
  metaJson: null,
  ...over,
});

describe("toAccountSections", () => {
  it("puts spot and manual rows in the spot table", () => {
    const s = toAccountSections([
      b({ id: "1", symbol: "ETH", usdValue: 5000, kind: "spot" }),
      b({ id: "2", symbol: "CASH", usdValue: 100, kind: "manual" }),
    ]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["ETH", "CASH"]);
    expect(s.defi).toEqual([]);
    expect(s.perp).toBeNull();
  });

  it("groups defi rows by protocol (preserving first-seen order, with fallback)", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "aUSDC",
        kind: "defi",
        usdValue: 2000,
        metaJson: JSON.stringify({ protocol: "Aave", positionType: "deposit" }),
      }),
      b({
        id: "2",
        symbol: "UNI-LP",
        kind: "defi",
        usdValue: 5000,
        metaJson: JSON.stringify({ protocol: "Uniswap", positionType: "lp" }),
      }),
      b({
        id: "3",
        symbol: "aETH",
        kind: "defi",
        usdValue: -2500,
        metaJson: JSON.stringify({ protocol: "Aave", positionType: "loan" }),
      }),
      b({ id: "4", symbol: "MYST", kind: "defi", usdValue: 10, metaJson: null }), // 无 protocol → fallback
    ]);
    expect(s.defi.map((g) => g.protocol)).toEqual(["Aave", "Uniswap", "Other"]);
    const aave = s.defi[0];
    expect(aave.rows.map((r) => r.symbol)).toEqual(["aUSDC", "aETH"]);
    expect(aave.rows[1].usdValue).toBe(-2500); // 负债保留
    expect(aave.rows[0].positionType).toBe("deposit");
  });

  it("routes perp rows through toPerpView", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "USDC",
        kind: "perp",
        usdValue: 13109,
        metaJson: JSON.stringify({
          role: "equity",
          withdrawable: 13000,
          totalMarginUsed: 5,
          totalNtlPos: 100,
        }),
      }),
      b({
        id: "2",
        symbol: "ETH",
        kind: "perp",
        usdValue: 0,
        metaJson: JSON.stringify({
          role: "position",
          side: "long",
          entryPx: 2986,
          positionValue: 100,
          unrealizedPnl: -1,
          liquidationPx: null,
          marginUsed: 5,
        }),
      }),
    ]);
    expect(s.perp?.equity?.accountValue).toBe(13109);
    expect(s.perp?.positions).toHaveLength(1);
    expect(s.spot).toEqual([]);
  });

  it("handles an empty account", () => {
    expect(toAccountSections([])).toEqual({ spot: [], defi: [], perp: null, accountDetail: null });
  });

  it("aggregates every balance's detail into one accountDetail (order preserved, \\n-joined)", () => {
    const s = toAccountSections([
      b({ id: "1", symbol: "BTC", kind: "spot", usdValue: 30000, detail: "- BTC: 0.02" }),
      b({ id: "2", symbol: "ETH", kind: "spot", usdValue: 9000 }), // 无 detail → 跳过
      b({ id: "3", symbol: "SOL", kind: "spot", usdValue: 100, detail: "- SOL: 1" }),
    ]);
    // 按 balance 顺序、仅非空、\n 连接
    expect(s.accountDetail).toBe("- BTC: 0.02\n- SOL: 1");
    // detail 不再挂在 spot 行上
    expect(s.spot.map((r) => r.symbol)).toEqual(["BTC", "ETH", "SOL"]);
  });

  it("routes the BTC balance's markdown detail into accountDetail", () => {
    const md = "**Unconfirmed:** +0.005 BTC";
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "BTC",
        kind: "spot",
        usdValue: 5000,
        tokenKey: "chain:bitcoin/native:btc",
        detail: md,
      }),
    ]);
    // BTC 进现货表,detail 上移到账户级
    expect(s.spot.map((r) => r.symbol)).toEqual(["BTC"]);
    expect(s.accountDetail).toBe(md);
  });

  it("carries locked through to the spot row", () => {
    const s = toAccountSections([
      b({ id: "1", symbol: "BTC", kind: "spot", usdValue: 30000, locked: 0.02 }),
      b({ id: "2", symbol: "ETH", kind: "spot", usdValue: 9000 }),
    ]);
    expect(s.spot.find((r) => r.symbol === "BTC")?.locked).toBe(0.02);
    expect(s.spot.find((r) => r.symbol === "ETH")?.locked ?? null).toBeNull();
  });

  it("no balance has detail → accountDetail null", () => {
    const s = toAccountSections([
      b({ id: "1", symbol: "BTC", kind: "spot", usdValue: 5000 }),
      b({ id: "2", symbol: "ETH", kind: "spot", usdValue: 9000 }),
    ]);
    expect(s.spot).toHaveLength(2);
    expect(s.accountDetail).toBeNull();
  });

  // —— 并存期:遗留 kind=utxo(旧 BTC 快照)归一到现货表,不 throw ——
  it("legacy kind=utxo → spot table (backward compat)", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "BTC",
        kind: "utxo",
        usdValue: 5000,
        tokenKey: "chain:bitcoin/native:btc",
      }),
    ]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["BTC"]);
  });

  it("新 kind=perp_equity/perp_position:走 perp 视图", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "USDC",
        kind: "perp_equity",
        usdValue: 1000,
        metaJson: JSON.stringify({ withdrawable: 900, totalMarginUsed: 100, totalNtlPos: 5000 }),
      }),
      b({
        id: "2",
        symbol: "BTC",
        kind: "perp_position",
        usdValue: 0,
        metaJson: JSON.stringify({
          side: "short",
          entryPx: 64000,
          positionValue: 640,
          unrealizedPnl: 12.5,
          liquidationPx: null,
          marginUsed: 64,
        }),
      }),
    ]);
    expect(s.perp?.equity?.accountValue).toBe(1000);
    expect(s.perp?.positions).toHaveLength(1);
    expect(s.perp?.positions[0].side).toBe("short");
    expect(s.spot).toEqual([]);
  });

  it("未知 kind 兜底为现货(不 throw)", () => {
    const s = toAccountSections([b({ id: "1", symbol: "???", kind: "mystery", usdValue: 1 })]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["???"]);
  });
});

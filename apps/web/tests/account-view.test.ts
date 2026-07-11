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

  it("balance 级 note(单个 Note)透传到 SpotRow.note(note 重设计)", () => {
    const note = {
      title: "Locked",
      icon: "warning" as const,
      content: [{ label: "ETH", value: 1, unit: "ETH" }],
    };
    const s = toAccountSections([
      b({ id: "1", symbol: "ETH", usdValue: 5000, kind: "spot", note }),
      b({ id: "2", symbol: "BTC", usdValue: 100, kind: "spot" }), // 无 note 的行
    ]);
    expect(s.spot.find((r) => r.symbol === "ETH")?.note).toEqual(note);
    expect(s.spot.find((r) => r.symbol === "BTC")?.note).toBeUndefined();
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
    expect(toAccountSections([])).toEqual({
      spot: [],
      defi: [],
      perp: null,
    });
  });

  // BTC(utxo/spot 口径)仍进现货表;展示明细(未确认/派生/收款)已提到账户级 note(note 重设计),
  // 不再由 toAccountSections 从 per-balance meta 抽出。
  it("BTC 行进现货表(spot 口径)", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "BTC",
        kind: "spot",
        usdValue: 5000,
        tokenKey: "chain:bitcoin/native:btc",
        metaJson: JSON.stringify({ pendingSats: 500000 }),
      }),
    ]);
    expect(s.spot.map((r) => r.symbol)).toEqual(["BTC"]);
  });

  it("BTC 行进现货表(utxo 口径)", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "BTC",
        kind: "utxo",
        usdValue: 5000,
        tokenKey: "chain:bitcoin/native:btc",
        metaJson: JSON.stringify({ pendingSats: 12345 }),
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

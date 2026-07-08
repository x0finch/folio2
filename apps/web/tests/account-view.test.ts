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
    expect(s.utxo).toBeNull();
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
    expect(toAccountSections([])).toEqual({ spot: [], defi: [], perp: null, utxo: null });
  });

  it("extracts Bitcoin meta (pending + xpub distribution/receive) from the BTC balance", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "BTC",
        kind: "spot",
        usdValue: 5000,
        tokenKey: "chain:bitcoin/native:btc",
        metaJson: JSON.stringify({
          pendingSats: 500000,
          addresses: [
            {
              address: "bc1qrecv",
              path: "m/84'/0'/0'/0/0",
              chain: "receive",
              balanceSats: 50000,
              pendingSats: 0,
            },
          ],
          receive: {
            lastUsed: { index: 0, address: "bc1qrecv" },
            next: [{ index: 1, address: "bc1qnext" }],
          },
        }),
      }),
    ]);
    // BTC 仍进现货表
    expect(s.spot.map((r) => r.symbol)).toEqual(["BTC"]);
    // 明细抽出
    expect(s.utxo?.pendingSats).toBe(500000);
    expect(s.utxo?.addresses?.[0].address).toBe("bc1qrecv");
    expect(s.utxo?.receive?.next[0]).toEqual({ index: 1, address: "bc1qnext" });
  });

  it("no Bitcoin detail when meta is empty (address mode, zero pending)", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "BTC",
        kind: "spot",
        usdValue: 5000,
        tokenKey: "chain:bitcoin/native:btc",
        metaJson: JSON.stringify({ pendingSats: 0 }),
      }),
    ]);
    expect(s.utxo).toBeNull();
    expect(s.spot).toHaveLength(1);
  });

  // —— 迁移后的新 5-kind(并存期一并支持) ——
  it("新 kind=utxo:进现货表 + 抽出明细", () => {
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
    expect(s.utxo?.pendingSats).toBe(12345);
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

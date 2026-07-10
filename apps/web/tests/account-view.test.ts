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

  it("parses + aggregates provider detail blocks from detailJson (empty when none)", () => {
    expect(toAccountSections([b({ id: "1", symbol: "ETH" })]).detail).toEqual([]);
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "BTC",
        detailJson: JSON.stringify([
          { type: "stat", label: "Overview.btcPending", value: 42, format: "sats" },
          {
            type: "addressList",
            label: "Overview.btcReceive",
            items: [{ address: "bc1qnext", index: 1 }],
            qr: true,
          },
        ]),
      }),
      b({ id: "2", symbol: "ETH" }),
    ]);
    expect(s.detail).toHaveLength(2);
    expect(s.detail[0]).toMatchObject({ type: "stat", value: 42 });
    expect(s.detail[1]).toMatchObject({ type: "addressList", qr: true });
  });

  it("skips malformed / unknown detail blocks per-item (graceful degradation, no throw)", () => {
    // 坏 JSON / 非数组 → 空;数组内未知的单块跳过,已知块保留(前向兼容)。
    expect(
      toAccountSections([b({ id: "1", symbol: "BTC", detailJson: "not json" })]).detail,
    ).toEqual([]);
    const s = toAccountSections([
      b({
        id: "2",
        symbol: "BTC",
        detailJson: JSON.stringify([
          { type: "mystery", foo: 1 }, // 未知块 → 跳过
          { type: "stat", label: "Overview.btcPending", value: 7, format: "sats" }, // 保留
        ]),
      }),
    ]);
    expect(s.detail).toHaveLength(1);
    expect(s.detail[0]).toMatchObject({ type: "stat", value: 7 });
  });

  it("handles an empty account", () => {
    expect(toAccountSections([])).toEqual({
      spot: [],
      defi: [],
      perp: null,
      detail: [],
    });
  });

  // —— 老快照兼容(ADR 0010:遗留 kind 归 spot,BTC 展示细节改走 detail 块,不再从 meta 抽 utxo 分区) ——
  it("legacy kind='utxo' 行归入现货表(不 throw,老快照的 UtxoMeta 不再解析)", () => {
    const s = toAccountSections([
      b({
        id: "1",
        symbol: "BTC",
        kind: "utxo", // 老快照写的遗留 kind 字符串
        usdValue: 5000,
        tokenKey: "chain:bitcoin/native:btc",
        // 老 UtxoMeta metaJson —— 不再被解析成分区,只需不崩
        metaJson: JSON.stringify({ pendingSats: 12345, addresses: [{ address: "bc1q" }] }),
      }),
    ]);
    // BTC 进现货表(数量/金额口径不变),无 utxo 分区
    expect(s.spot.map((r) => r.symbol)).toEqual(["BTC"]);
    expect(s.spot[0].usdValue).toBe(5000);
    expect("utxo" in s).toBe(false);
  });

  it("legacy BTC 骑 spot(带 chain:bitcoin tokenKey + 老 UtxoMeta)仍归现货表", () => {
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
    expect(s.spot).toHaveLength(1);
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

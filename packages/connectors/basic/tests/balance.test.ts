import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { Balance, type BalanceKind, Defi, type PerpPosition, Spot } from "../src/balance";

describe("Balance 4-kind 判别联合 —— runtime parse", () => {
  it("spot:纯基础行,零 typed meta(ADR 0010)", () => {
    const b = Balance.parse({ kind: "spot", symbol: "BTC", amount: 1, value: 100 });
    expect(b).toMatchObject({ kind: "spot", symbol: "BTC", value: 100 });
  });

  it("spot:携 detail 展示块(BTC 未确认/派生地址走此)", () => {
    const b = Balance.parse({
      kind: "spot",
      symbol: "BTC",
      amount: 1,
      value: 100,
      detail: [{ type: "stat", label: "Overview.btcPending", value: 42, format: "sats" }],
    });
    expect(b.kind).toBe("spot");
    expect(b.detail).toHaveLength(1);
  });

  it("defi:带 protocol/positionType meta", () => {
    const b = Balance.parse({
      kind: "defi",
      symbol: "aUSDC",
      amount: 50,
      value: 50,
      meta: { protocol: "aave", positionType: "deposit" },
    });
    expect(b.kind).toBe("defi");
    if (b.kind === "defi") expect(b.meta.protocol).toBe("aave"); // kind 窄化后 meta 精确
  });

  it("perp_equity / perp_position:各自 meta", () => {
    const eq = Balance.parse({
      kind: "perp_equity",
      symbol: "ACCT",
      amount: 1,
      value: 1000,
      meta: { withdrawable: 900, totalMarginUsed: 100, totalNtlPos: 5000 },
    });
    expect(eq.kind).toBe("perp_equity");
    const pos = Balance.parse({
      kind: "perp_position",
      symbol: "BTC-PERP",
      amount: 1,
      value: 0, // 仓位行不承载净值
      meta: {
        side: "long",
        entryPx: 60000,
        positionValue: 60000,
        unrealizedPnl: 500,
        liquidationPx: null,
        marginUsed: 6000,
      },
    });
    expect(pos.kind).toBe("perp_position");
  });

  it("未知/遗留 kind 被拒(utxo/manual/perp 已不在联合)", () => {
    expect(() => Balance.parse({ kind: "utxo", symbol: "X", amount: 1, value: 1 })).toThrow();
    expect(() => Balance.parse({ kind: "manual", symbol: "X", amount: 1, value: 1 })).toThrow();
    expect(() => Balance.parse({ kind: "perp", symbol: "X", amount: 1, value: 1 })).toThrow();
  });

  it("defi 缺 meta 被拒(meta 随 kind 必填)", () => {
    expect(() => Balance.parse({ kind: "defi", symbol: "X", amount: 1, value: 1 })).toThrow();
  });

  it("perp_position 缺必填 meta 字段被拒", () => {
    expect(() =>
      Balance.parse({
        kind: "perp_position",
        symbol: "X",
        amount: 1,
        value: 0,
        meta: { side: "long" },
      }),
    ).toThrow();
  });
});

describe("Balance —— 类型完备", () => {
  it("BalanceKind 恰为 4 个 kind", () => {
    expectTypeOf<BalanceKind>().toEqualTypeOf<"spot" | "defi" | "perp_equity" | "perp_position">();
  });

  it("子集 schema 的 z.infer 精确到该子集(defineConnector 推断基础)", () => {
    const spotDefi = z.discriminatedUnion("kind", [Spot, Defi]);
    expectTypeOf<z.infer<typeof spotDefi>>().toEqualTypeOf<
      z.infer<typeof Spot> | z.infer<typeof Defi>
    >();
  });

  it("kind 窄化后 meta 自动精确(消灭 as cast)", () => {
    const b = Balance.parse({
      kind: "perp_position",
      symbol: "X",
      amount: 1,
      value: 0,
      meta: {
        side: "short",
        entryPx: 1,
        positionValue: 1,
        unrealizedPnl: 0,
        liquidationPx: 1,
        marginUsed: 1,
      },
    });
    if (b.kind === "perp_position") {
      expectTypeOf(b.meta).toEqualTypeOf<PerpPosition["meta"]>();
      expect(b.meta.side).toBe("short");
    }
  });
});

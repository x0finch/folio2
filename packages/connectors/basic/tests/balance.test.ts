import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { Balance, type BalanceKind, Defi, type PerpPosition, Spot } from "../src/balance";

describe("Balance 5-kind 判别联合 —— runtime parse", () => {
  it("spot:无 meta 的基础行", () => {
    const b = Balance.parse({ kind: "spot", symbol: "BTC", amount: 1, value: 100 });
    expect(b).toMatchObject({ kind: "spot", symbol: "BTC", value: 100 });
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

  it("utxo:pendingSats 必填、地址表/收款可选", () => {
    const b = Balance.parse({
      kind: "utxo",
      symbol: "BTC",
      amount: 0.5,
      value: 30000,
      meta: { pendingSats: 0 },
    });
    expect(b.kind).toBe("utxo");
  });

  it("未知 kind 被拒", () => {
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
  it("BalanceKind 恰为 5 个 kind", () => {
    expectTypeOf<BalanceKind>().toEqualTypeOf<
      "spot" | "defi" | "perp_equity" | "perp_position" | "utxo"
    >();
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

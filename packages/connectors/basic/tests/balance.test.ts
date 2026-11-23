import { describe, expect, expectTypeOf, it } from "vitest";
import { z } from "zod";
import { Balance, type BalanceKind, Defi, type PerpPosition, Spot } from "../src/balance";

describe("Balance discriminated union: runtime parse", () => {
  it("spot: a plain token row with no typed meta", () => {
    const b = Balance.parse({
      kind: "spot",
      symbol: "BTC",
      tokenRef: "bitcoin/native",
      amount: 1,
      value: 100,
    });
    expect(b).toMatchObject({ kind: "spot", symbol: "BTC", value: 100 });
  });

  it("defi: carries protocol/positionType meta", () => {
    const b = Balance.parse({
      kind: "defi",
      symbol: "aUSDC",
      tokenRef: "evm:1/0xa0b8",
      amount: 50,
      value: 50,
      meta: { protocol: "aave", positionType: "deposit" },
    });
    expect(b.kind).toBe("defi");
    if (b.kind === "defi") expect(b.meta.protocol).toBe("aave");
  });

  it("perp_equity / perp_position: each with its own meta", () => {
    const eq = Balance.parse({
      kind: "perp_equity",
      symbol: "ACCT",
      tokenRef: "hyperliquid/issued:X",
      amount: 1,
      value: 1000,
      meta: { withdrawable: 900, totalMarginUsed: 100, totalNtlPos: 5000 },
    });
    expect(eq.kind).toBe("perp_equity");
    const pos = Balance.parse({
      kind: "perp_position",
      symbol: "BTC-PERP",
      tokenRef: "hyperliquid/issued:X",
      amount: 1,
      value: 0, // position rows carry no net worth
      meta: {
        coin: "BTC",
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

  it("rejects unknown kinds, including the retired utxo", () => {
    expect(() =>
      Balance.parse({ kind: "manual", symbol: "X", tokenRef: "x/y", amount: 1, value: 1 }),
    ).toThrow();
    expect(() =>
      Balance.parse({ kind: "perp", symbol: "X", tokenRef: "x/y", amount: 1, value: 1 }),
    ).toThrow();
    expect(() =>
      Balance.parse({ kind: "utxo", symbol: "BTC", tokenRef: "x/y", amount: 0.5, value: 30000 }),
    ).toThrow();
  });

  it("rejects defi without meta", () => {
    expect(() =>
      Balance.parse({ kind: "defi", symbol: "X", tokenRef: "x/y", amount: 1, value: 1 }),
    ).toThrow();
  });

  it("rejects perp_position missing required meta fields", () => {
    expect(() =>
      Balance.parse({
        kind: "perp_position",
        symbol: "X",
        tokenRef: "hyperliquid/issued:X",
        amount: 1,
        value: 0,
        meta: { side: "long" },
      }),
    ).toThrow();
  });
});

describe("Balance types", () => {
  it("BalanceKind is exactly the four kinds", () => {
    expectTypeOf<BalanceKind>().toEqualTypeOf<"spot" | "defi" | "perp_equity" | "perp_position">();
  });

  it("z.infer of a subset schema is exactly that subset", () => {
    const spotDefi = z.discriminatedUnion("kind", [Spot, Defi]);
    expectTypeOf<z.infer<typeof spotDefi>>().toEqualTypeOf<
      z.infer<typeof Spot> | z.infer<typeof Defi>
    >();
  });

  it("narrowing on kind makes meta precise without casts", () => {
    const b = Balance.parse({
      kind: "perp_position",
      symbol: "X",
      tokenRef: "hyperliquid/issued:X",
      amount: 1,
      value: 0,
      meta: {
        coin: "X",
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

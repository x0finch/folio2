import { describe, expect, it } from "vitest";
import type { Holding, HoldingSource } from "@/lib/core/portfolio";
import {
  ALLOC_DIMENSION,
  buildAllocation,
  DEFAULT_DIM,
  OTHERS_KEY,
} from "@/routes/_authed/-insights/allocation";

const src = (
  platformId: string,
  platformName: string,
  accountId: string,
  value: number,
): HoldingSource => ({
  platform: { id: platformId, name: platformName },
  account: { id: accountId, label: accountId },
  amount: 0,
  value,
  kind: "spot",
});
const holding = (key: string, symbol: string, sources: HoldingSource[]): Holding => ({
  key,
  token: { symbol, name: symbol },
  totalValue: sources.reduce((s, x) => s + x.value, 0),
  sources,
});

const holdings: Holding[] = [
  holding("group:usdc", "USDC", [
    src("evm:1", "Ethereum", "z1", 100),
    src("evm:42161", "Arbitrum", "z1", 50),
    src("exchange:binance", "Binance", "b1", 30),
  ]),
  holding("token:coingecko:bitcoin", "BTC", [src("manual", "Manual", "m1", 700)]),
];

describe("buildAllocation", () => {
  it("token dim: one slice per holding, value = totalValue", () => {
    const a = buildAllocation(holdings, "token");
    expect(a).toEqual([
      { key: "token:coingecko:bitcoin", label: "BTC", value: 700 },
      { key: "group:usdc", label: "USDC", value: 180 },
    ]);
  });

  it("chain dim: group sources by platform, sums to holdings total", () => {
    const a = buildAllocation(holdings, "chain");
    const byLabel = Object.fromEntries(a.map((s) => [s.label, s.value]));
    expect(byLabel).toEqual({ Manual: 700, Ethereum: 100, Arbitrum: 50, Binance: 30 });
    expect(a.reduce((s, x) => s + x.value, 0)).toBe(880); // = Σ holdings
  });

  it("account dim: group sources by account", () => {
    const a = buildAllocation(holdings, "account");
    const byKey = Object.fromEntries(a.map((s) => [s.key, s.value]));
    expect(byKey).toEqual({ m1: 700, z1: 150, b1: 30 });
  });

  it("collapses beyond topN into an others slice", () => {
    const many: Holding[] = Array.from({ length: 12 }, (_, i) =>
      holding(`t${i}`, `T${i}`, [src("evm:1", "Ethereum", "a", 12 - i)]),
    );
    const a = buildAllocation(many, "token", 8);
    expect(a).toHaveLength(9); // 8 + others
    expect(a[8].key).toBe(OTHERS_KEY);
    expect(a.reduce((s, x) => s + x.value, 0)).toBe(many.reduce((s, h) => s + h.totalValue, 0));
  });

  it("empty holdings → empty", () => {
    expect(buildAllocation([], "token")).toEqual([]);
  });
});

describe("维度 schema —— Insights 的 `?dim=` 就靠它回落", () => {
  const parse = (v: unknown) => ALLOC_DIMENSION.catch(DEFAULT_DIM).parse(v);

  it("三个合法维度原样通过", () => {
    expect(parse("token")).toBe("token");
    expect(parse("chain")).toBe("chain");
    expect(parse("account")).toBe("account");
  });

  it("别的一律回落默认维度", () => {
    expect(parse("bogus")).toBe(DEFAULT_DIM);
    expect(parse("")).toBe(DEFAULT_DIM);
    expect(parse(undefined)).toBe(DEFAULT_DIM);
    expect(parse(42)).toBe(DEFAULT_DIM);
    expect(parse(["token", "chain"])).toBe(DEFAULT_DIM);
  });
});

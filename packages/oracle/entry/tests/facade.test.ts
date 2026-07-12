import type { FxStore, PlatformStore, TokenStore } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { createOracle } from "../src/oracle";
import { createTokens } from "../src/tokens";
import { BASELINE_VENDOR, pickVendor } from "../src/vendors";

// #79 AC:createOracle 返回统一 Oracle = {tokens,platforms,fx}。createTokens 仍在(shim/旧 import 用),
// 但不再是 createOracle 的别名(语义已分离:前者建 Tokens,后者建三服务门面)。
describe("oracle facade", () => {
  // store 工厂在被碰的服务首访时才调、方法亦惰性 → 可传最小占位。
  const cfg = {
    createTokenStore: () => ({}) as TokenStore,
    platformStore: () => ({}) as PlatformStore,
    fxStore: () => ({}) as FxStore,
  };

  it("createOracle 返回 {tokens,platforms,fx} 三服务", () => {
    const oracle = createOracle(cfg);
    expect(typeof oracle.tokens.priceOf).toBe("function");
    expect(typeof oracle.tokens.resolve).toBe("function");
    expect(typeof oracle.platforms.resolve).toBe("function");
    expect(typeof oracle.fx.resolve).toBe("function");
  });

  it("createTokens 仍导出且为函数(不再是 createOracle 别名)", () => {
    expect(typeof createTokens).toBe("function");
    expect((createOracle as unknown) === (createTokens as unknown)).toBe(false);
  });
});

describe("pickVendor 能力路由", () => {
  it("活跃源声明该能力 → 用活跃源(coingecko 全能力)", () => {
    expect(pickVendor("prices", "coingecko").vendor.id).toBe(BASELINE_VENDOR);
    expect(pickVendor("fxRates", "coingecko").vendor.id).toBe(BASELINE_VENDOR);
  });

  it("未知活跃源 → 回退 baseline", () => {
    expect(pickVendor("prices", "does-not-exist").vendor.id).toBe(BASELINE_VENDOR);
  });

  it("活跃源 DefiLlama(仅 prices):prices 走它,tokenMeta/platformMeta/fxRates 回退 baseline(#83)", () => {
    expect(pickVendor("prices", "defillama").vendor.id).toBe("defillama");
    expect(pickVendor("tokenMeta", "defillama").vendor.id).toBe(BASELINE_VENDOR);
    expect(pickVendor("platformMeta", "defillama").vendor.id).toBe(BASELINE_VENDOR);
    expect(pickVendor("fxRates", "defillama").vendor.id).toBe(BASELINE_VENDOR);
  });
});

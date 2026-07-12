import type { FxStore, OracleVendor, PlatformStore, TokenStore } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { createOracle } from "../src/oracle";
import { createTokens } from "../src/tokens";
import { BASELINE_VENDOR, pickVendor, VENDORS, type VendorImpl } from "../src/vendors";

// #79 AC:createOracle 返回统一 Oracle = {tokens,platforms,fx}。createTokens 仍在(shim/旧 import 用),
// 但不再是 createOracle 的别名(语义已分离:前者建 Tokens,后者建三服务门面)。
describe("oracle facade", () => {
  // store 实例在构造期不被调用(方法惰性)→ 可传最小占位。
  const cfg = {
    createTokenStore: () => ({}) as TokenStore,
    platformStore: {} as PlatformStore,
    fxStore: {} as FxStore,
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

  it("活跃源缺该能力 → 回退 baseline(仅供其声明的能力)", () => {
    // 临时注册一个只声明 prices 的假源(模拟 DefiLlama),验路由:prices 走它、tokenMeta 回退 baseline。
    const fakeVendor: OracleVendor = { id: "fake", capabilities: new Set(["prices"]) };
    const fake: VendorImpl = { vendor: fakeVendor };
    VENDORS.fake = fake;
    try {
      expect(pickVendor("prices", "fake").vendor.id).toBe("fake");
      expect(pickVendor("tokenMeta", "fake").vendor.id).toBe(BASELINE_VENDOR);
      expect(pickVendor("fxRates", "fake").vendor.id).toBe(BASELINE_VENDOR);
    } finally {
      delete VENDORS.fake;
    }
  });
});

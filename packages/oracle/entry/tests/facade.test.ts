import type { FxStore, PlatformStore, TokenStore } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { createOracle } from "../src/oracle";
import { createTokens } from "../src/services/tokens";
import { pickSource, VENDORS } from "../src/vendors";

// #79 AC:createOracle 返回统一 Oracle = {tokens,platforms,fx}。createTokens 仍在(shim/旧 import 用),
// 但不再是 createOracle 的别名(语义已分离:前者建 Tokens,后者建三服务门面)。
describe("oracle facade", () => {
  // store 工厂在被碰的服务首访时才调、方法亦惰性 → 可传最小占位。
  const cfg = {
    createTokenStore: () => ({}) as TokenStore,
    createPlatformStore: () => ({}) as PlatformStore,
    createFxStore: () => ({}) as FxStore,
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

describe("pickSource 选源路由", () => {
  it("baseline(coingecko)挂 token/platform/fx → 用它的", () => {
    expect(pickSource("coingecko", "token")).toBe(VENDORS.coingecko.token);
    expect(pickSource("coingecko", "fx")).toBe(VENDORS.coingecko.fx);
  });

  it("未知活跃源 → 回退 baseline", () => {
    expect(pickSource("does-not-exist", "token")).toBe(VENDORS.coingecko.token);
  });

  it("活跃源 DefiLlama(仅 price):价走它,token/platform/fx 回退 baseline(#83)", () => {
    expect(pickSource("defillama", "price")).toBe(VENDORS.defillama.price);
    expect(pickSource("defillama", "token")).toBe(VENDORS.coingecko.token);
    expect(pickSource("defillama", "platform")).toBe(VENDORS.coingecko.platform);
    expect(pickSource("defillama", "fx")).toBe(VENDORS.coingecko.fx);
  });
});

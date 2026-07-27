import type { PlatformStore, TokenStore } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { createOracle } from "../src/oracle";
import { createTokens } from "../src/services/tokens";

// #79 AC:createOracle 返回统一 Oracle 门面。createTokens 仍在(shim/旧 import 用),
// 但不再是 createOracle 的别名(语义已分离:前者建 Tokens,后者建门面)。
// 汇率已搬进 @folio/oracle2(#202b),故不再在这里。
describe("oracle facade", () => {
  // store 工厂在被碰的服务首访时才调、方法亦惰性 → 可传最小占位。
  const cfg = {
    createTokenStore: () => ({}) as TokenStore,
    createPlatformStore: () => ({}) as PlatformStore,
  };

  it("createOracle 返回 {tokens,platforms}", () => {
    const oracle = createOracle(cfg);
    expect(typeof oracle.tokens.priceOf).toBe("function");
    expect(typeof oracle.tokens.resolve).toBe("function");
    expect(typeof oracle.platforms.resolve).toBe("function");
  });

  it("createTokens 仍导出且为函数(不再是 createOracle 别名)", () => {
    expect(typeof createTokens).toBe("function");
    expect((createOracle as unknown) === (createTokens as unknown)).toBe(false);
  });
});

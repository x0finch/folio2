import { describe, expect, it } from "vitest";
import { createOracle, createTokens } from "../src";

// #71 AC:门面组装入口名为 createOracle。createTokens 保留为旧名别名(Phase 2 收口)。
describe("oracle facade", () => {
  it("暴露 createOracle 组装入口", () => {
    expect(typeof createOracle).toBe("function");
  });

  it("createTokens 是 createOracle 的别名(同一函数)", () => {
    expect(createTokens).toBe(createOracle);
  });
});

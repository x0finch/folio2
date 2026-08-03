import { describe, expect, it } from "vitest";
import { orderSections } from "../src/components/section-list";

// section list(ADR 0034):按小计倒序、剔除空段、平手按 key 稳定。
const s = (key: string, subtotal: number, count: number) => ({ key, subtotal, count });

describe("orderSections", () => {
  it("按小计倒序", () => {
    const out = orderSections([s("tokens", 100, 3), s("perps", 500, 1), s("defi", 300, 2)]);
    expect(out.map((x) => x.key)).toEqual(["perps", "defi", "tokens"]);
  });

  it("剔除空段(count=0)", () => {
    const out = orderSections([s("tokens", 100, 3), s("perps", 999, 0), s("defi", 50, 1)]);
    expect(out.map((x) => x.key)).toEqual(["tokens", "defi"]);
  });

  it("小计平手 → 按 key 稳定排序(不抖动)", () => {
    const out = orderSections([s("perps", 100, 1), s("defi", 100, 1)]);
    expect(out.map((x) => x.key)).toEqual(["defi", "perps"]);
  });

  it("全空 → 空数组", () => {
    expect(orderSections([s("tokens", 0, 0), s("perps", 0, 0)])).toEqual([]);
  });
});

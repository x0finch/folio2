import { describe, expect, it } from "vitest";
import { orderSections } from "../src/routes/_authed/-home/holdings/section-list";

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

  it("负小计(如永续负权益)照数值倒序", () => {
    const out = orderSections([s("perps", -50, 1), s("tokens", 100, 2), s("defi", -10, 1)]);
    expect(out.map((x) => x.key)).toEqual(["tokens", "defi", "perps"]); // 100 > -10 > -50
  });

  it("小计为 NaN → 当 0 处理,排序确定(不落到与数值无关的位置)", () => {
    const out = orderSections([s("a", Number.NaN, 1), s("b", 5, 1), s("c", -5, 1)]);
    // NaN 视作 0 → b(5) > a(0) > c(-5)
    expect(out.map((x) => x.key)).toEqual(["b", "a", "c"]);
  });
});

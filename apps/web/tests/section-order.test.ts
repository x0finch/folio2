import { describe, expect, it } from "vitest";
import { orderSections } from "@/routes/_authed/-home/holdings/section-list";

const s = (key: string, subtotal: number, count: number) => ({ key, subtotal, count });

describe("orderSections", () => {
  it("sorted by subtotal descending", () => {
    const out = orderSections([s("tokens", 100, 3), s("perps", 500, 1), s("defi", 300, 2)]);
    expect(out.map((x) => x.key)).toEqual(["perps", "defi", "tokens"]);
  });

  it("drops empty sections (count=0)", () => {
    const out = orderSections([s("tokens", 100, 3), s("perps", 999, 0), s("defi", 50, 1)]);
    expect(out.map((x) => x.key)).toEqual(["tokens", "defi"]);
  });

  it("tied subtotals: stable sort by key (no jitter)", () => {
    const out = orderSections([s("perps", 100, 1), s("defi", 100, 1)]);
    expect(out.map((x) => x.key)).toEqual(["defi", "perps"]);
  });

  it("all empty: empty array", () => {
    expect(orderSections([s("tokens", 0, 0), s("perps", 0, 0)])).toEqual([]);
  });

  it("negative subtotals (e.g. negative perp equity) still sort by value descending", () => {
    const out = orderSections([s("perps", -50, 1), s("tokens", 100, 2), s("defi", -10, 1)]);
    expect(out.map((x) => x.key)).toEqual(["tokens", "defi", "perps"]); // 100 > -10 > -50
  });

  it("NaN subtotal: treated as 0, ordering deterministic (not landing at a position unrelated to its value)", () => {
    const out = orderSections([s("a", Number.NaN, 1), s("b", 5, 1), s("c", -5, 1)]);
    expect(out.map((x) => x.key)).toEqual(["b", "a", "c"]);
  });
});

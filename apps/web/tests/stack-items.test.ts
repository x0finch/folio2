import { describe, expect, it } from "vitest";
import { buildStack, type StackEntry } from "@/components/avatar-stack";
import { ZERO_DISPLAY_USD } from "@/lib/core/account-view";

const e = (k: string, magnitude: number, logo?: string): StackEntry => ({
  k,
  name: k,
  logo,
  magnitude,
});

describe("buildStack", () => {
  it("sorted by magnitude descending", () => {
    expect(buildStack([e("a", 10), e("b", 100), e("c", 50)]).map((i) => i.k)).toEqual([
      "b",
      "c",
      "a",
    ]);
  });

  it("**compares absolute values**: negatives (empty position / borrow leg) do not sink because of their sign", () => {
    expect(buildStack([e("a", 10), e("big-short", -100)]).map((i) => i.k)).toEqual([
      "big-short",
      "a",
    ]);
  });

  it("same key accumulates (signed, several holdings of one token can offset each other)", () => {
    const items = buildStack([e("a", 100), e("a", -60), e("b", 50)]);
    expect(items.map((i) => i.k)).toEqual(["b", "a"]);
  });

  it("logo takes **the first one that has an image**, not the first-seen row", () => {
    expect(buildStack([e("a", 1), e("a", 1, "late.png")])[0]?.logo).toBe("late.png");
  });

  it("name takes the first seen", () => {
    expect(buildStack([{ ...e("A", 1), name: "aave" }, e("A", 1)])[0]?.name).toBe("aave");
  });

  it("by default drops almost-$0 cells by the display threshold", () => {
    const items = buildStack([e("real", 100), e("dust", ZERO_DISPLAY_USD / 2), e("zero", 0)]);
    expect(items.map((i) => i.k)).toEqual(["real"]);
  });

  it("each dust but **the total** passes the threshold: kept (accumulate before judging)", () => {
    const half = ZERO_DISPLAY_USD * 0.6;
    expect(buildStack([e("a", half), e("a", half)]).map((i) => i.k)).toEqual(["a"]);
  });

  it('`dust: 0`: only sorts, no dropping (the source rows use it: avatar count must match "across n platforms")', () => {
    expect(buildStack([e("a", 100), e("tiny", 0.0001)], 0).map((i) => i.k)).toEqual(["a", "tiny"]);
  });

  it("empty: []", () => {
    expect(buildStack([])).toEqual([]);
  });
});

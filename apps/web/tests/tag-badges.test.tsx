import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TagBadges } from "@/components/tag-badges";

const tags = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `t${i}` }));

const textOf = (n: number, max?: number) => {
  const { container } = render(<TagBadges tags={tags(n)} max={max} />);
  return container.textContent;
};

describe("TagBadges", () => {
  it("fits: all laid out flat, exactly equal to max does not fold", () => {
    expect(textOf(3, 3)).toBe("#t0#t1#t2");
  });

  it("over max: gives the last slot to the count tail", () => {
    expect(textOf(4, 3)).toBe("#t0#t1+2");
    expect(textOf(9, 3)).toBe("#t0#t1+7");
  });

  it("no max passed: no folding (drawer)", () => {
    expect(textOf(5)).toBe("#t0#t1#t2#t3#t4");
  });

  it("empty list renders nothing", () => {
    expect(textOf(0, 3)).toBe("");
  });
});

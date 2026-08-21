import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TagBadges } from "@/components/tag-badges";

// TagBadges 折叠规则(#351):max = 这一行最多占几格,**计数尾巴自己算一格** ——
// 装得下就全平铺,装不下才 `#a #b +3`。边界(恰好 = max)最容易写错,重点锁它。

const tags = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `t${i}`, name: `t${i}` }));

const textOf = (n: number, max?: number) => {
  const { container } = render(<TagBadges tags={tags(n)} max={max} />);
  return container.textContent;
};

describe("TagBadges", () => {
  it("装得下就全平铺,恰好等于 max 时不折叠", () => {
    expect(textOf(3, 3)).toBe("#t0#t1#t2");
  });

  it("超过 max → 让出最后一格给计数尾巴", () => {
    expect(textOf(4, 3)).toBe("#t0#t1+2"); // 显 2 个,尾巴报剩下 2 个
    expect(textOf(9, 3)).toBe("#t0#t1+7");
  });

  it("不传 max = 不折叠(抽屉)", () => {
    expect(textOf(5)).toBe("#t0#t1#t2#t3#t4");
  });

  it("空列表不渲染", () => {
    expect(textOf(0, 3)).toBe("");
  });
});

import { describe, expect, it } from "vitest";
import { collapseToSlots } from "../src/lib/collapse-to-slots";

// 账户行的 tag(#a #b +2)与代币抽屉平台行的账户(@a @b +2)共用这一条规则(#351):
// max = 最多占几格,**计数尾巴自己算一格**。边界(恰好 = max)最容易写错,重点锁它。

const items = (n: number) => Array.from({ length: n }, (_, i) => `i${i}`);

describe("collapseToSlots", () => {
  it("恰好等于 max → 不折叠,全平铺", () => {
    expect(collapseToSlots(items(3), 3)).toEqual({ shown: ["i0", "i1", "i2"], overflow: 0 });
  });

  it("超过 max → 让出最后一格给尾巴", () => {
    expect(collapseToSlots(items(4), 3)).toEqual({ shown: ["i0", "i1"], overflow: 2 });
    expect(collapseToSlots(items(9), 3)).toEqual({ shown: ["i0", "i1"], overflow: 7 });
  });

  it("不传 max = 不折叠", () => {
    expect(collapseToSlots(items(9), undefined).overflow).toBe(0);
  });

  // 调用方只有「前几名」时(SourceGroup.topAccounts 带前 3、真实总数在 count 上):
  // 按 total 判折叠,余量按 total 算 —— 不能拿 items.length 当总数,那会少报。
  it("total 单独传:按它判折叠、算余量", () => {
    expect(collapseToSlots(items(3), 3, 3)).toEqual({ shown: ["i0", "i1", "i2"], overflow: 0 });
    expect(collapseToSlots(items(3), 3, 9)).toEqual({ shown: ["i0", "i1"], overflow: 7 });
  });

  it("空列表", () => {
    expect(collapseToSlots([], 3)).toEqual({ shown: [], overflow: 0 });
  });
});

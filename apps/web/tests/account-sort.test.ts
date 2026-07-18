import { describe, expect, it } from "vitest";
import { sortActiveAccounts } from "../src/lib/account-sort";

describe("sortActiveAccounts", () => {
  it("未同步过(takenAt=null)置顶,其余按价值倒序", () => {
    const rows = [
      { id: "a", takenAt: 1, totalUsd: 100 },
      { id: "b", takenAt: null, totalUsd: 0 },
      { id: "c", takenAt: 2, totalUsd: 500 },
    ];
    expect(sortActiveAccounts(rows).map((r) => r.id)).toEqual(["b", "c", "a"]);
  });

  it("多个未同步账户保持相对顺序(稳定)", () => {
    const rows = [
      { id: "n1", takenAt: null, totalUsd: 0 },
      { id: "s", takenAt: 5, totalUsd: 50 },
      { id: "n2", takenAt: null, totalUsd: 0 },
    ];
    expect(sortActiveAccounts(rows).map((r) => r.id)).toEqual(["n1", "n2", "s"]);
  });

  it("不改动入参(返回新数组)", () => {
    const rows = [
      { id: "a", takenAt: 1, totalUsd: 100 },
      { id: "c", takenAt: 2, totalUsd: 500 },
    ];
    const sorted = sortActiveAccounts(rows);
    expect(rows.map((r) => r.id)).toEqual(["a", "c"]); // 原数组不变
    expect(sorted.map((r) => r.id)).toEqual(["c", "a"]);
  });
});

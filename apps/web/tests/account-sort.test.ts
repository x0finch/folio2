import { describe, expect, it } from "vitest";
import { sortActiveAccounts } from "../src/lib/account-sort";

describe("sortActiveAccounts", () => {
  it("按市值倒序(无特殊分档)", () => {
    const rows = [
      { id: "a", totalUsd: 100 },
      { id: "b", totalUsd: 0 },
      { id: "c", totalUsd: 500 },
    ];
    expect(sortActiveAccounts(rows).map((r) => r.id)).toEqual(["c", "a", "b"]);
  });

  it("同市值保持相对顺序(稳定)", () => {
    const rows = [
      { id: "x", totalUsd: 50 },
      { id: "y", totalUsd: 50 },
      { id: "z", totalUsd: 100 },
    ];
    expect(sortActiveAccounts(rows).map((r) => r.id)).toEqual(["z", "x", "y"]);
  });

  it("不改动入参(返回新数组)", () => {
    const rows = [
      { id: "a", totalUsd: 100 },
      { id: "c", totalUsd: 500 },
    ];
    const sorted = sortActiveAccounts(rows);
    expect(rows.map((r) => r.id)).toEqual(["a", "c"]); // 原数组不变
    expect(sorted.map((r) => r.id)).toEqual(["c", "a"]);
  });
});

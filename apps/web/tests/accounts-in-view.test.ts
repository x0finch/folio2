import { describe, expect, it } from "vitest";
import { accountIdsInView, accountsInView } from "../src/lib/accounts-in-view";

// accountsInView(ADR 0033):活跃 && 归属选中 Portfolio;未归属的账户兜底进默认视图。

const acc = (id: string, archivedAt: number | null = null) => ({ id, archivedAt });
const DEFAULT = "pf-default";
const WATCH = "pf-watch";

describe("accountsInView", () => {
  it("只返回归属选中 Portfolio 的账户", () => {
    const accounts = [acc("a"), acc("b"), acc("c")];
    const memberships = [
      { accountId: "a", portfolioId: DEFAULT },
      { accountId: "b", portfolioId: WATCH },
      { accountId: "c", portfolioId: DEFAULT },
    ];
    expect(accountsInView(accounts, memberships, DEFAULT, DEFAULT).map((a) => a.id)).toEqual([
      "a",
      "c",
    ]);
    expect(accountsInView(accounts, memberships, WATCH, DEFAULT).map((a) => a.id)).toEqual(["b"]);
  });

  it("排除归档账户(与 Portfolio 归属正交)", () => {
    const accounts = [acc("a"), acc("b", 123)];
    const memberships = [
      { accountId: "a", portfolioId: DEFAULT },
      { accountId: "b", portfolioId: DEFAULT },
    ];
    expect(accountsInView(accounts, memberships, DEFAULT, DEFAULT).map((a) => a.id)).toEqual(["a"]);
  });

  it("未归属账户兜底进**默认**视图(钱不隐形)", () => {
    const accounts = [acc("a"), acc("orphan")];
    const memberships = [{ accountId: "a", portfolioId: DEFAULT }];
    // 看默认:orphan 兜底计入。
    expect(accountsInView(accounts, memberships, DEFAULT, DEFAULT).map((a) => a.id)).toEqual([
      "a",
      "orphan",
    ]);
    // 看非默认:orphan 不兜底。
    expect(accountsInView(accounts, memberships, WATCH, DEFAULT)).toEqual([]);
  });

  it("空归属 + 看默认 → 全部活跃账户(片2 的向后兼容前提)", () => {
    const accounts = [acc("a"), acc("b"), acc("c", 999)];
    expect(accountsInView(accounts, [], DEFAULT, DEFAULT).map((a) => a.id)).toEqual(["a", "b"]);
  });
});

describe("accountIdsInView", () => {
  const memberships = [
    { accountId: "a", portfolioId: DEFAULT },
    { accountId: "b", portfolioId: WATCH },
    { accountId: "arch", portfolioId: WATCH },
  ];

  it("与归档无关:归属选中的 id 全收(含已归档成员,供曲线过去点)", () => {
    // arch 归档与否都在 Watch 成员集里 —— 曲线保留其历史贡献。
    const set = accountIdsInView(["a", "b", "arch"], memberships, WATCH, DEFAULT);
    expect([...set].sort()).toEqual(["arch", "b"]);
  });

  it("未归属 id 兜底进默认成员集,非默认则不兜底", () => {
    const ids = ["a", "b", "orphan"];
    expect(accountIdsInView(ids, memberships, DEFAULT, DEFAULT).has("orphan")).toBe(true);
    expect(accountIdsInView(ids, memberships, WATCH, DEFAULT).has("orphan")).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { buildAccountRows } from "@/routes/_authed/-accounts/list-rows";

// 账户页那一行是四个来源拼出来的,拼装规则从路由 loader 里搬到了纯模块(#413)。
// 钉的是**拼装规则**,不是搬家这件事:哪些字段在某个来源缺席时该退成什么。

const account = (over: Partial<Parameters<typeof buildAccountRows>[0]["accounts"][number]> = {}) =>
  ({
    id: "a1",
    label: "Binance",
    connectorId: "binance",
    archivedAt: null,
    needsCredentials: false,
    credsSafe: {},
    ...over,
    // biome-ignore lint/suspicious/noExplicitAny: 测试替身只喂拼装用得到的字段
  }) as any;

const build = (over: Partial<Parameters<typeof buildAccountRows>[0]> = {}) =>
  buildAccountRows({
    accounts: [account()],
    // biome-ignore lint/suspicious/noExplicitAny: 同上
    holdings: { rows: [], pricesStale: false } as any,
    allTags: [],
    tagLinks: [],
    ...over,
  });

describe("buildAccountRows", () => {
  it("持仓查询还没到 → valuesReady 为 false,市值不充当真实 0", () => {
    const [row] = build({ holdings: undefined });
    expect(row.valuesReady).toBe(false);
  });

  it("持仓那一源里没有这个账户 → 市值/上次同步/持仓退成空,而不是整行消失", () => {
    // 退化路径:没有任何快照的账户(刚加、还没同步过)。
    // **归档账户不再走这条** —— 归档 = 封存(ADR 0039),它在持仓那一源里有封存值,见下一条。
    const [row] = build({ accounts: [account({ archivedAt: 1700000000000 })] });
    expect(row.valuesReady).toBe(true);
    expect(row.totalUsd).toBe(0);
    expect(row.takenAt).toBeNull();
    expect(row.balances).toEqual([]);
    expect(row.archivedAt).toBe(1700000000000);
  });

  it("归档账户在持仓那一源里有封存值 → 照常取用,不因为归档就抹成 0", () => {
    const [row] = build({
      accounts: [account({ archivedAt: 1700000000000 })],
      holdings: {
        rows: [
          { account: { id: "a1" }, totalUsd: 999, takenAt: 1690000000000, balances: [{ x: 1 }] },
        ],
        pricesStale: false,
        // biome-ignore lint/suspicious/noExplicitAny: 测试替身
      } as any,
    });
    expect(row.archivedAt).toBe(1700000000000);
    expect(row.valuesReady).toBe(true);
    expect(row.totalUsd).toBe(999);
    expect(row.takenAt).toBe(1690000000000);
    expect(row.balances).toHaveLength(1);
  });

  it("持仓那一源有这个账户 → 市值与上次同步取它的", () => {
    const [row] = build({
      holdings: {
        rows: [{ account: { id: "a1" }, totalUsd: 1234, takenAt: 42, balances: [{ x: 1 }] }],
        pricesStale: false,
        // biome-ignore lint/suspicious/noExplicitAny: 测试替身
      } as any,
    });
    expect(row.totalUsd).toBe(1234);
    expect(row.takenAt).toBe(42);
    expect(row.balances).toHaveLength(1);
  });

  it("标签按 id 解析;指向已不存在的标签的关联被跳过,不留幽灵标签", () => {
    const [row] = build({
      allTags: [{ id: "t1", name: "longterm", portfolioId: "p1" }],
      tagLinks: [
        { accountId: "a1", tagId: "t1" },
        { accountId: "a1", tagId: "ghost" },
        { accountId: "other", tagId: "t1" },
      ],
    });
    expect(row.tags).toEqual([{ id: "t1", name: "longterm" }]);
  });

  // 归属**随账户行来**(ADR 0047:服务端按组合筛,顺手把归属带上)—— 拼装这一层不再反查归属表,
  // 所以这条钉的是「原样透传」。
  it("归属原样从账户行透传", () => {
    expect(build({ accounts: [account({ portfolioId: "p9" })] })[0].portfolioId).toBe("p9");
  });
});

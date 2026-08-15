import { describe, expect, it } from "vitest";
import { buildAccountRows } from "../src/routes/_authed/-accounts/rows";

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
    memberships: [],
    allTags: [],
    tagLinks: [],
    ...over,
  });

describe("buildAccountRows", () => {
  it("持仓那一源里没有这个账户 → 市值/上次同步/持仓退成空,而不是整行消失", () => {
    // 退化路径:没有任何快照的账户(刚加、还没同步过)。
    // **归档账户不再走这条** —— 归档 = 封存(ADR 0039),它在持仓那一源里有封存值,见下一条。
    const [row] = build({ accounts: [account({ archivedAt: 1700000000000 })] });
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

  it("没有归属记录的账户 portfolioId 退成空串(而不是 undefined)", () => {
    expect(build()[0].portfolioId).toBe("");
    expect(build({ memberships: [{ accountId: "a1", portfolioId: "p9" }] })[0].portfolioId).toBe(
      "p9",
    );
  });
});

describe("24h 盈亏要透传到行上(ADR 0040)", () => {
  // 这一条是浏览器实测抓出来的:合并函数漏了这个字段,于是账户页整列连 `—` 都不显示 ——
  // 组件那边读到 undefined 就整行省略,看起来像「这个功能压根没做」。
  // biome-ignore lint/suspicious/noExplicitAny: 测试替身只喂拼装用得到的字段
  const withGain = (gain24h: unknown) => ({ rows: [{ account: { id: "a1" }, gain24h }] }) as any;

  it("活跃账户:算得出的数原样带上", () => {
    const rows = build({ holdings: withGain({ amount: 12.5, pct: 1.2 }) });
    expect(rows[0].gain24h).toEqual({ amount: 12.5, pct: 1.2 });
  });

  it("算不出的 null 也要带上 —— 界面据此画 `—`,而不是整行省略", () => {
    const rows = build({ holdings: withGain(null) });
    expect(rows[0].gain24h).toBeNull();
  });

  it("归档账户是 undefined —— 不该有这个数,整行省略", () => {
    const rows = build({ holdings: withGain(undefined) });
    expect(rows[0].gain24h).toBeUndefined();
  });
});

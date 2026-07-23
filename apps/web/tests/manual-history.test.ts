import { describe, expect, it } from "vitest";
import {
  buildManualAccountSeries,
  type HistoryToken,
  tokenPriceAt,
  tokenQuantityAt,
} from "../src/lib/manual-history";

// manual 价值历史 compute-on-read(ADR 0018 / T5,#157):账本为真,value@T = quantity@T × price@T。
// 折叠数量、price@T 降级链、回溯编辑整条重算(无 stale)。纯逻辑,与 deriveAmount 同 fold 语义。
const DAY = 86_400_000;
const T1 = 1 * DAY;
const T2 = 2 * DAY;
const T3 = 3 * DAY;

// createdAt 仅在 occurredAt 相同时定序;各测用递增值即可。
const act = (
  kind: "add" | "reduce" | "set",
  amount: number,
  occurredAt: number,
  price?: number | null,
  createdAt = occurredAt,
) => ({ kind, amount, occurredAt, createdAt, price });

describe("tokenQuantityAt", () => {
  it("折叠 occurredAt ≤ T 的活动(set 重置 / add += / reduce -=)", () => {
    const tk: HistoryToken = {
      unitPrice: 10,
      activities: [act("set", 2, T1), act("add", 1, T2), act("reduce", 0.5, T3)],
    };
    expect(tokenQuantityAt(tk, T1)).toBe(2); // 仅 set
    expect(tokenQuantityAt(tk, T2)).toBe(3); // set + add
    expect(tokenQuantityAt(tk, T3)).toBe(2.5); // set + add - reduce
    expect(tokenQuantityAt(tk, T1 - 1)).toBe(0); // set 之前无持仓
  });

  it("reduce 过量 → 末值夹 0,不为负", () => {
    const tk: HistoryToken = {
      unitPrice: 10,
      activities: [act("set", 1, T1), act("reduce", 5, T2)],
    };
    expect(tokenQuantityAt(tk, T2)).toBe(0);
  });
});

describe("tokenPriceAt 降级链", () => {
  const tk: HistoryToken = {
    unitPrice: 100,
    identifier: "bitcoin",
    activities: [act("set", 1, T1, 60000), act("add", 1, T2, 65000), act("reduce", 0.5, T3, null)],
  };

  it("② 账本价:occurredAt ≤ T 最近一条记了 price 的活动", () => {
    expect(tokenPriceAt(tk, T1)).toBe(60000);
    expect(tokenPriceAt(tk, T2)).toBe(65000);
    expect(tokenPriceAt(tk, T3)).toBe(65000); // T3 那条 price=null → 回落到 T2 的 65000
  });

  it("③ unitPrice 摊平:该时刻前无任何记了 price 的活动", () => {
    const noPrice: HistoryToken = { unitPrice: 42, activities: [act("set", 1, T2, null)] };
    expect(tokenPriceAt(noPrice, T2)).toBe(42);
    // T1 时刻(首活动之前)也回落 unitPrice
    expect(tokenPriceAt(tk, T1 - 1)).toBe(100);
  });

  it("① priceAt 注入(#148 oracle 历史价)优先于账本价", () => {
    const priceAt = (id: string, t: number) => (id === "bitcoin" ? t / DAY + 0.5 : undefined);
    expect(tokenPriceAt(tk, T1, priceAt)).toBe(1.5); // 用 oracle,非账本 60000
    // priceAt 返回 undefined → 落回账本价②
    const miss = (_id: string, _t: number) => undefined;
    expect(tokenPriceAt(tk, T2, miss)).toBe(65000);
    // 无 identifier → 不查 oracle,直接账本价
    const local: HistoryToken = { unitPrice: 1, activities: [act("set", 1, T1, 7)] };
    expect(tokenPriceAt(local, T1, priceAt)).toBe(7);
  });
});

describe("buildManualAccountSeries", () => {
  it("每个活动时刻一行,totalUsd = Σ_token quantity@T × price@T", () => {
    const btc: HistoryToken = {
      unitPrice: 100,
      identifier: "bitcoin",
      activities: [act("set", 1, T1, 60000), act("add", 1, T3, 70000)],
    };
    const eth: HistoryToken = {
      unitPrice: 10,
      identifier: "ethereum",
      activities: [act("set", 2, T2, 3000)],
    };
    const series = buildManualAccountSeries("acc", [btc, eth]);
    expect(series).toEqual([
      { accountId: "acc", takenAt: T1, totalUsd: 60000 }, // btc 1×60000, eth 0
      { accountId: "acc", takenAt: T2, totalUsd: 60000 + 6000 }, // + eth 2×3000
      { accountId: "acc", takenAt: T3, totalUsd: 2 * 70000 + 6000 }, // btc 2×70000, eth 2×3000
    ]);
  });

  it("空账户 / 无活动 → 空序列", () => {
    expect(buildManualAccountSeries("acc", [])).toEqual([]);
    expect(buildManualAccountSeries("acc", [{ unitPrice: 5, activities: [] }])).toEqual([]);
  });

  it("补录一条更早活动 → 曲线自该时点起变化(整条重算,新增前置点)", () => {
    const before: HistoryToken = {
      unitPrice: 100,
      activities: [act("set", 1, T2, 50000)],
    };
    const base = buildManualAccountSeries("acc", [before]);
    expect(base.map((p) => p.takenAt)).toEqual([T2]);

    // 用户补录「其实 T1 就买了 0.5」→ 序列新增 T1 点,且 T2 的持仓被抬到 1(set 覆盖,但数量口径整体重算)。
    const after: HistoryToken = {
      unitPrice: 100,
      activities: [act("add", 0.5, T1, 40000), act("set", 1, T2, 50000)],
    };
    const series = buildManualAccountSeries("acc", [after]);
    expect(series).toEqual([
      { accountId: "acc", takenAt: T1, totalUsd: 0.5 * 40000 }, // 新前置点
      { accountId: "acc", takenAt: T2, totalUsd: 1 * 50000 }, // set 重置到 1
    ]);
  });

  it("删除过去活动 → 曲线整体重算,无 stale 残留", () => {
    const full: HistoryToken = {
      unitPrice: 100,
      activities: [act("set", 1, T1, 40000), act("add", 2, T2, 50000)],
    };
    expect(buildManualAccountSeries("acc", [full]).map((p) => p.totalUsd)).toEqual([
      40000,
      3 * 50000,
    ]);

    // 删掉 T2 那笔 add → 只剩 T1 点,T2 点消失(不留旧的 3×50000)。
    const pruned: HistoryToken = { unitPrice: 100, activities: [act("set", 1, T1, 40000)] };
    expect(buildManualAccountSeries("acc", [pruned])).toEqual([
      { accountId: "acc", takenAt: T1, totalUsd: 40000 },
    ]);
  });

  it("修改过去活动 amount → 自该时点起全部下游点重算", () => {
    const edited: HistoryToken = {
      unitPrice: 100,
      // T1 的 set 从 1 改成 3 → T1 与 T2 两点都变(下游累积基线抬升)。
      activities: [act("set", 3, T1, 40000), act("add", 1, T2, 50000)],
    };
    expect(buildManualAccountSeries("acc", [edited])).toEqual([
      { accountId: "acc", takenAt: T1, totalUsd: 3 * 40000 },
      { accountId: "acc", takenAt: T2, totalUsd: 4 * 50000 },
    ]);
  });
});

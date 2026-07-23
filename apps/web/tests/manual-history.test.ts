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

// 网格采样(ADR 0019):从首活动所在 UTC 日到 now 逐日一行,τ(b) = min(日末, now)。DAY 对齐的
// occurredAt 让日桶数学干净:dayBucketOf(n×DAY)=n,dayEnd(b)=(b+1)×DAY-1。当日日末 τ 恰在下一日活动之前。
describe("buildManualAccountSeries(grid, ADR 0019)", () => {
  const dayEnd = (b: number) => (b + 1) * DAY - 1;

  it("日网格逐日一行;value@τ = Σ_token quantity@τ × price@τ(降级②账本价)", () => {
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
    // now = T3(桶3)→ 网格桶 1,2,3。无 priceAt 注入 → 价走账本②。
    const series = buildManualAccountSeries("acc", [btc, eth], T3);
    expect(series).toEqual([
      // 桶1 日末(< T2)→ btc 1×60000,eth 尚无。
      { accountId: "acc", takenAt: dayEnd(1), totalUsd: 60000 },
      // 桶2 日末 → btc 1×60000 + eth 2×3000。
      { accountId: "acc", takenAt: dayEnd(2), totalUsd: 60000 + 6000 },
      // 桶3 末点 τ=now=T3 → btc 2×70000(add 计入)+ eth 2×3000。
      { accountId: "acc", takenAt: T3, totalUsd: 2 * 70000 + 6000 },
    ]);
  });

  it("① 注入 priceAt(oracle 历史价)按日桶驱动价,优先于账本价", () => {
    const btc: HistoryToken = {
      unitPrice: 100,
      identifier: "bitcoin",
      activities: [act("set", 1, T1, 60000)],
    };
    // priceAt 按日桶给价(1000×桶号),验证网格逐日取的是 oracle 价而非账本 60000。
    const priceAt = (id: string, t: number) =>
      id === "bitcoin" ? 1000 * Math.floor(t / DAY) : undefined;
    const series = buildManualAccountSeries("acc", [btc], T2, priceAt);
    expect(series).toEqual([
      { accountId: "acc", takenAt: dayEnd(1), totalUsd: 1 * 1000 }, // 桶1 → 1000
      { accountId: "acc", takenAt: T2, totalUsd: 1 * 2000 }, // 桶2(τ=now)→ 2000
    ]);
  });

  it("窗口外存量:首活动远早于后续日,每日点仍反映折出的存量(修 T5「窗口外被丢」缺口)", () => {
    const btc: HistoryToken = { unitPrice: 100, activities: [act("set", 2, T1, 60000)] };
    // 仅一笔 T1 活动,now = 桶4 → 应有 4 个逐日点,均携带存量 2×60000(旧实现只有 T1 一个点)。
    const series = buildManualAccountSeries("acc", [btc], 4 * DAY);
    expect(series).toHaveLength(4);
    expect(series.every((p) => p.totalUsd === 2 * 60000)).toBe(true);
    expect(series.map((p) => p.takenAt)).toEqual([dayEnd(1), dayEnd(2), dayEnd(3), 4 * DAY]);
  });

  it("空账户 / 无活动 → 空序列", () => {
    expect(buildManualAccountSeries("acc", [], T3)).toEqual([]);
    expect(buildManualAccountSeries("acc", [{ unitPrice: 5, activities: [] }], T3)).toEqual([]);
  });

  it("补录更早活动 → 网格起点前移 + 整条重算,无 stale", () => {
    const before: HistoryToken = { unitPrice: 100, activities: [act("set", 1, T2, 50000)] };
    // now = T2 → 只有桶2 一点。
    expect(buildManualAccountSeries("acc", [before], T2)).toEqual([
      { accountId: "acc", takenAt: T2, totalUsd: 1 * 50000 },
    ]);

    // 补录「T1 就买了 0.5」→ 网格起点回到桶1,桶2 的 set 仍重置到 1(整体重算)。
    const after: HistoryToken = {
      unitPrice: 100,
      activities: [act("add", 0.5, T1, 40000), act("set", 1, T2, 50000)],
    };
    expect(buildManualAccountSeries("acc", [after], T2)).toEqual([
      { accountId: "acc", takenAt: dayEnd(1), totalUsd: 0.5 * 40000 }, // 新前置日
      { accountId: "acc", takenAt: T2, totalUsd: 1 * 50000 }, // set 重置
    ]);
  });

  it("删除过去活动 → 整体重算不留 stale", () => {
    const full: HistoryToken = {
      unitPrice: 100,
      activities: [act("set", 1, T1, 40000), act("add", 2, T2, 50000)],
    };
    // now = T2 → 桶1(仅 set,1×40000)、桶2(1+2=3,×50000)。
    expect(buildManualAccountSeries("acc", [full], T2).map((p) => p.totalUsd)).toEqual([
      1 * 40000,
      3 * 50000,
    ]);

    // 删掉 T2 那笔 add → 桶2 数量回落到 1(set),不留旧的 3×50000。
    const pruned: HistoryToken = { unitPrice: 100, activities: [act("set", 1, T1, 40000)] };
    expect(buildManualAccountSeries("acc", [pruned], T2)).toEqual([
      { accountId: "acc", takenAt: dayEnd(1), totalUsd: 40000 },
      { accountId: "acc", takenAt: T2, totalUsd: 40000 }, // 存量 1 携带到桶2
    ]);
  });
});

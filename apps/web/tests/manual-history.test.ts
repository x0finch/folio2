import { describe, expect, it } from "vitest";
import type { SnapshotTotalRow } from "../src/lib/core/history";
import {
  accountTotalAt,
  buildManualAccountSeries,
  type HistoryToken,
  isReduceOversold,
  tokenPriceAt,
  tokenQuantityAt,
} from "../src/lib/core/manual";

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
      id: "tk",
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
      id: "tk",
      unitPrice: 10,
      activities: [act("set", 1, T1), act("reduce", 5, T2)],
    };
    expect(tokenQuantityAt(tk, T2)).toBe(0);
  });
});

describe("tokenPriceAt 降级链", () => {
  const tk: HistoryToken = {
    id: "tk",
    unitPrice: 100,
    recognized: true,
    activities: [act("set", 1, T1, 60000), act("add", 1, T2, 65000), act("reduce", 0.5, T3, null)],
  };

  it("② 账本价:occurredAt ≤ T 最近一条记了 price 的活动", () => {
    expect(tokenPriceAt(tk, T1)).toBe(60000);
    expect(tokenPriceAt(tk, T2)).toBe(65000);
    expect(tokenPriceAt(tk, T3)).toBe(65000); // T3 那条 price=null → 回落到 T2 的 65000
  });

  it("③ unitPrice 摊平:该时刻前无任何记了 price 的活动", () => {
    const noPrice: HistoryToken = {
      id: "tk",
      unitPrice: 42,
      activities: [act("set", 1, T2, null)],
    };
    expect(tokenPriceAt(noPrice, T2)).toBe(42);
    // T1 时刻(首活动之前)也回落 unitPrice
    expect(tokenPriceAt(tk, T1 - 1)).toBe(100);
  });

  it("① priceAt 注入(#148 oracle 历史价)优先于账本价", () => {
    const priceAt = (id: string, t: number) => (id === "tk" ? t / DAY + 0.5 : undefined);
    expect(tokenPriceAt(tk, T1, priceAt)).toBe(1.5); // 用 oracle,非账本 60000
    // priceAt 返回 undefined → 落回账本价②
    const miss = (_id: string, _t: number) => undefined;
    expect(tokenPriceAt(tk, T2, miss)).toBe(65000);
    // 上游不认识 → 不查 oracle,直接账本价
    const local: HistoryToken = { id: "tk", unitPrice: 1, activities: [act("set", 1, T1, 7)] };
    expect(tokenPriceAt(local, T1, priceAt)).toBe(7);
  });
});

// 法币现金(ADR 0026 / #274):历史价 = **当天汇率**,由 server 侧把 fx-history 灌进注入的 priceAt。
// 纯层不认识 fiat —— 它只走 recognized+priceAt 那条路(第 ① 档),所以「按当天汇率画」在这一层
// 就是「priceAt 每天给不同的值,曲线跟着走,不被账本冻价拖平」。这几条钉住这个不变量。
describe("法币现金:历史价走注入的当天汇率(路径①)", () => {
  // fiatCode 只在 server 决定「问汇率还是问币价」,纯层照旧只看 recognized。
  const eur: HistoryToken = {
    id: "eur",
    unitPrice: 0,
    recognized: true,
    fiatCode: "EUR",
    activities: [act("set", 100, T1, 1.15)], // 账本冻的入账汇率 1.15
  };
  // 逐日不同的汇率闭包(server 侧 rateSeries 的替身)。
  const fxAt = (id: string, t: number) =>
    id === "eur" ? { [T1]: 1.2, [T2]: 1.1, [T3]: 1.05 }[t] : undefined;

  it("各点用当天汇率,而非账本冻的 1.15", () => {
    expect(tokenPriceAt(eur, T1, fxAt)).toBe(1.2);
    expect(tokenPriceAt(eur, T2, fxAt)).toBe(1.1);
    // 100 单位 → 账户额随汇率变:T1 = 120,T2 = 110(不是恒 115)。
    expect(accountTotalAt([eur], T1, fxAt)).toBeCloseTo(120, 6);
    expect(accountTotalAt([eur], T2, fxAt)).toBeCloseTo(110, 6);
  });

  it("USD 现金:汇率恒 1 → 全程 ×数量,行为不变", () => {
    const usd: HistoryToken = {
      id: "usd",
      unitPrice: 0,
      recognized: true,
      fiatCode: "USD",
      activities: [act("set", 500, T1, 1)],
    };
    const one = (_id: string, _t: number) => 1; // USD 恒 1
    expect(accountTotalAt([usd], T1, one)).toBe(500);
    expect(accountTotalAt([usd], T3, one)).toBe(500);
  });

  it("上游缺该日 → priceAt 返 undefined → 降级链落账本价②(不崩)", () => {
    const miss = (_id: string, _t: number) => undefined;
    expect(tokenPriceAt(eur, T1, miss)).toBe(1.15); // 落账本冻价
  });
});

// 网格采样(ADR 0019,锚定模型):采样时刻 = 首活动锚点 ∪ 其后每个 UTC 日末 ∪ now(并集升序)。
// 首点恒在首活动、末点恒在 now → 任一有活动账户 ≥2 点(抽屉 series.length≥2 渲染门)。DAY 对齐的
// occurredAt(T1=1×DAY…是日起点)让日桶数学干净;dayEnd(b)=(b+1)×DAY-1。
describe("accountTotalAt", () => {
  it("Σ_token quantity@t × price@t(账本价②)", () => {
    const btc: HistoryToken = { id: "tk", unitPrice: 100, activities: [act("set", 2, T1, 60000)] };
    const eth: HistoryToken = { id: "tk", unitPrice: 10, activities: [act("set", 3, T1, 3000)] };
    expect(accountTotalAt([btc, eth], T1)).toBe(2 * 60000 + 3 * 3000);
    expect(accountTotalAt([btc, eth], T1 - 1)).toBe(0); // 开仓前
  });
});

describe("isReduceOversold", () => {
  it("reduce 超过此前持有 → true", () => {
    const acts = [act("add", 1, T1), act("reduce", 2, T2)];
    expect(isReduceOversold(acts, acts[1])).toBe(true); // 持 1 卖 2
  });
  it("有更早开仓覆盖 → false", () => {
    const acts = [act("set", 10, 0), act("add", 1, T1), act("reduce", 2, T2)];
    expect(isReduceOversold(acts, acts[2])).toBe(false); // 持 11 卖 2
  });
  it("恰好卖到 0(未超) → false", () => {
    const acts = [act("add", 1, T1), act("reduce", 1, T2)];
    expect(isReduceOversold(acts, acts[1])).toBe(false);
  });
  it("非 reduce → false", () => {
    const acts = [act("add", 1, T1)];
    expect(isReduceOversold(acts, acts[0])).toBe(false);
  });
});

describe("buildManualAccountSeries(grid, ADR 0019)", () => {
  const last = (s: SnapshotTotalRow[]) => s[s.length - 1];

  it("单笔活动(当日)→ 首活动 + now 两点,可成线(修 series<2 抽屉不渲染)", () => {
    const btc: HistoryToken = { id: "tk", unitPrice: 100, activities: [act("set", 2, T1, 60000)] };
    const now = T1 + 6 * 3_600_000; // 同日晚 6h(T1 是日起点,仍在桶1)
    const series = buildManualAccountSeries("acc", [btc], now);
    expect(series.length).toBeGreaterThanOrEqual(2); // 关键:当日新账户也 ≥2 点
    expect(series[0].takenAt).toBe(T1); // 锚在首活动
    expect(last(series).takenAt).toBe(now); // 末点 = now
    expect(series.every((p) => p.totalUsd === 2 * 60000)).toBe(true); // 存量 2 × 账本价②
  });

  it("① 注入 priceAt(oracle 历史价)按日驱动价 + 跨日价格曲线形状", () => {
    const btc: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      recognized: true,
      activities: [act("set", 1, T1, 60000)],
    };
    // priceAt 按日桶给价(1000×桶号)→ 验证逐日取 oracle 价(非账本 60000),曲线随价单调升。
    const priceAt = (id: string, t: number) =>
      id === "tk" ? 1000 * Math.floor(t / DAY) : undefined;
    const series = buildManualAccountSeries("acc", [btc], T3, priceAt);
    expect(series[0]).toEqual({ accountId: "acc", takenAt: T1, totalUsd: 1000 }); // 桶1 → 1000
    expect(last(series)).toEqual({ accountId: "acc", takenAt: T3, totalUsd: 3000 }); // 桶3 → 3000
    expect(series.length).toBeGreaterThan(2); // 中间有跨日点体现价格起伏
    const totals = series.map((p) => p.totalUsd);
    expect(totals).toEqual([...totals].sort((a, b) => a - b)); // 数量恒1 → 随价单调
  });

  it("窗口外存量:首活动远早于 now,曲线铺到 now 且每点带折出的存量(修 T5 缺口)", () => {
    const btc: HistoryToken = { id: "tk", unitPrice: 100, activities: [act("set", 2, T1, 60000)] };
    const now = T1 + 4 * DAY; // 首活动后 4 天
    const series = buildManualAccountSeries("acc", [btc], now);
    expect(series[0].takenAt).toBe(T1);
    expect(last(series).takenAt).toBe(now);
    expect(series.length).toBeGreaterThanOrEqual(5); // 首活动 + 逐日 + now(旧实现只有 1 点)
    expect(series.every((p) => p.totalUsd === 2 * 60000)).toBe(true);
  });

  it("空账户 / 无活动 → 空序列", () => {
    expect(buildManualAccountSeries("acc", [], T3)).toEqual([]);
    expect(
      buildManualAccountSeries("acc", [{ id: "tk", unitPrice: 5, activities: [] }], T3),
    ).toEqual([]);
  });

  it("补录更早活动 → 起点前移到新首活动,整条重算", () => {
    const before: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      activities: [act("set", 1, T2, 50000)],
    };
    expect(buildManualAccountSeries("acc", [before], T3)[0].takenAt).toBe(T2); // 起点 = 唯一活动

    // 补录「T1 就买了 0.5」→ 起点回到 T1,末点(T3)的 set 仍重置到 1(整体重算)。
    const after: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      activities: [act("add", 0.5, T1, 40000), act("set", 1, T2, 50000)],
    };
    const series = buildManualAccountSeries("acc", [after], T3);
    expect(series[0]).toEqual({ accountId: "acc", takenAt: T1, totalUsd: 0.5 * 40000 }); // 新起点
    expect(last(series)).toEqual({ accountId: "acc", takenAt: T3, totalUsd: 1 * 50000 }); // set 重置到 1
  });

  it("删除过去活动 → 整体重算不留 stale", () => {
    const full: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      activities: [act("set", 1, T1, 40000), act("add", 2, T2, 50000)],
    };
    // 末点 T3:数量 1+2=3,② 最近价 50000。
    expect(last(buildManualAccountSeries("acc", [full], T3)).totalUsd).toBe(3 * 50000);

    // 删掉 T2 那笔 add → 数量回落到 1(set),不留旧的 3×50000。
    const pruned: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      activities: [act("set", 1, T1, 40000)],
    };
    const s = buildManualAccountSeries("acc", [pruned], T3);
    expect(s[0].takenAt).toBe(T1);
    expect(last(s).totalUsd).toBe(1 * 40000);
  });

  it("修改过去活动 amount → 下游重算", () => {
    const edited: HistoryToken = {
      id: "tk",
      unitPrice: 100,
      activities: [act("set", 3, T1, 40000), act("add", 1, T2, 50000)],
    };
    const series = buildManualAccountSeries("acc", [edited], T3);
    expect(series[0]).toEqual({ accountId: "acc", takenAt: T1, totalUsd: 3 * 40000 });
    expect(last(series)).toEqual({ accountId: "acc", takenAt: T3, totalUsd: 4 * 50000 });
  });
});

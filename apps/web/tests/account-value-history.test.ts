import { describe, expect, it } from "vitest";
import { buildAccountValueHistory } from "@/lib/core/history";

// 单账户价值历史(A2 抽屉头部 chart):该账户各快照 (takenAt, totalUsd) → 升序 HistoryPoint[]。
// 复用组合净值的阶梯重建(单账户 = 每 takenAt 一点),since 裁窗口,末点 = 最新快照冻结总额
// (与账户行/抽屉头 account.totalUsd 同源,曲线当下点 ≡ 头部数值)。
// 快照是事件驱动、天/小时级间隔;测试用天级(与 downsampleSeries 的小时最小桶相容,不被压桶)。
const DAY = 86_400_000;

describe("buildAccountValueHistory", () => {
  it("多快照 → 按时间升序,每点 total = 该时刻该账户总额", () => {
    const s = buildAccountValueHistory([
      { takenAt: 3 * DAY, totalUsd: 130 },
      { takenAt: 1 * DAY, totalUsd: 100 },
      { takenAt: 2 * DAY, totalUsd: 120 },
    ]);
    expect(s.map((p) => [p.t, p.total])).toEqual([
      [1 * DAY, 100],
      [2 * DAY, 120],
      [3 * DAY, 130],
    ]);
  });

  it("末点 = 最新快照总额(与头部 account.totalUsd 同源)", () => {
    const s = buildAccountValueHistory([
      { takenAt: 1 * DAY, totalUsd: 100 },
      { takenAt: 2 * DAY, totalUsd: 175 },
    ]);
    expect(s.at(-1)).toEqual({ t: 2 * DAY, total: 175 });
  });

  it("since 裁掉窗口外的更早快照", () => {
    const s = buildAccountValueHistory(
      [
        { takenAt: 1 * DAY, totalUsd: 100 },
        { takenAt: 2 * DAY, totalUsd: 120 },
        { takenAt: 3 * DAY, totalUsd: 130 },
      ],
      2 * DAY,
    );
    expect(s.map((p) => p.t)).toEqual([2 * DAY, 3 * DAY]);
  });

  it("窗口内不足 2 点 → 原样返回(调用方按 <2 不渲染 chart)", () => {
    expect(buildAccountValueHistory([{ takenAt: 1 * DAY, totalUsd: 100 }])).toEqual([
      { t: 1 * DAY, total: 100 },
    ]);
    expect(buildAccountValueHistory([], 50)).toEqual([]);
  });
});

// 「当下」那一点(FOL-38 之前住在 `loadAccountHistory` 里,随代码搬到这儿)。
// 只有未归档的手记账户带它:账本按当前价现算,与抽屉头 account.totalUsd 同源。
describe("buildAccountValueHistory 的当下点", () => {
  const rows = [
    { takenAt: 1 * DAY, totalUsd: 100 },
    { takenAt: 2 * DAY, totalUsd: 120 },
  ];

  it("当下点不晚于末点 → 顶替末点的值,不多出一个点", () => {
    const s = buildAccountValueHistory(rows, undefined, { t: 2 * DAY, total: 175 });
    expect(s).toEqual([
      { t: 1 * DAY, total: 100 },
      { t: 2 * DAY, total: 175 },
    ]);
  });

  it("当下点更晚 → 接在后面", () => {
    const s = buildAccountValueHistory(rows, undefined, { t: 5 * DAY, total: 175 });
    expect(s.at(-1)).toEqual({ t: 5 * DAY, total: 175 });
    expect(s).toHaveLength(3);
  });

  it("空账户不凭空造点 —— 与快照那条路的空态一致", () => {
    expect(buildAccountValueHistory([], undefined, { t: 5 * DAY, total: 175 })).toEqual([]);
    // 窗口把点全裁掉了也一样:那是「这段时间没有数据」,不是「现在值 175」。
    expect(buildAccountValueHistory(rows, 9 * DAY, { t: 5 * DAY, total: 175 })).toEqual([]);
  });

  it("没有当下点(快照账户 / 已归档)→ 末点就是最后一次同步的冻结值", () => {
    expect(buildAccountValueHistory(rows, undefined, null).at(-1)).toEqual({
      t: 2 * DAY,
      total: 120,
    });
  });
});

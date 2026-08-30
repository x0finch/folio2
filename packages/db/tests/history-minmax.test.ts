import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { HISTORY_MINMAX_BUCKETS } from "../src/domains/history-minmax";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

const snapshotsOf = forDomain((db) => db.snapshots);
const accounts = forDomain((db) => db.accounts);

const USER = "user-minmax";
const DAY = 86_400_000;

function buildPortfolioTimeline(
  rows: { accountId: string; takenAt: number; totalUsd: number }[],
): { t: number; total: number }[] {
  const sorted = [...rows].sort((a, b) => a.takenAt - b.takenAt);
  const latestByAccount = new Map<string, number>();
  const points: { t: number; total: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    latestByAccount.set(row.accountId, row.totalUsd);
    const isLastAtThisTime = i + 1 === sorted.length || sorted[i + 1].takenAt !== row.takenAt;
    if (!isLastAtThisTime) continue;
    let total = 0;
    for (const v of latestByAccount.values()) total += v;
    points.push({ t: row.takenAt, total });
  }
  return points;
}

// 真实组合净值 @ t = 各账户 ≤ t 最近一行之和(用全量原始行算,给闭合断言当参照系)。
function trueValueAt(
  allRows: { accountId: string; takenAt: number; totalUsd: number }[],
  t: number,
): number {
  const latest = new Map<string, number>();
  for (const r of [...allRows].sort((a, b) => a.takenAt - b.takenAt)) {
    if (r.takenAt <= t) latest.set(r.accountId, r.totalUsd);
  }
  let sum = 0;
  for (const v of latest.values()) sum += v;
  return sum;
}

async function resetUser(userId: string): Promise<void> {
  const db = getDb(env);
  await db.delete(user).where(eq(user.id, userId));
  await db.insert(user).values({
    id: userId,
    name: userId,
    email: `${userId}@example.com`,
    emailVerified: false,
    createdAt: new Date(),
    updatedAt: new Date(),
  });
}

async function seedManySnapshots(
  accountId: string,
  count: number,
  startAt: number,
  stepMs: number,
  valueAt: (i: number) => number,
) {
  for (let i = 0; i < count; i++) {
    await snapshotsOf(USER).write(accountId, {
      takenAt: startAt + i * stepMs,
      totalUsd: valueAt(i),
      balances: [],
    });
  }
}

beforeEach(async () => {
  await resetUser(USER);
});

describe("history min-max (FOL-46)", () => {
  it("listTotalsByAccountMinMax:响应行数与历史长度脱钩,全局极值保留", async () => {
    const acc = await accounts(USER).create({ connectorId: "binance", label: "B", creds: "x" });
    const start = 1_000_000;
    await seedManySnapshots(acc.id, 120, start, DAY, (i) => 100 + Math.sin(i / 3) * 50);

    const raw = await snapshotsOf(USER).listTotalsByAccount(acc.id);
    const sampled = await snapshotsOf(USER).listTotalsByAccountMinMax(acc.id);

    expect(raw).toHaveLength(120);
    expect(sampled.length).toBeLessThanOrEqual(HISTORY_MINMAX_BUCKETS * 2);
    expect(sampled.length).toBeGreaterThan(10);

    const rawMin = Math.min(...raw.map((r) => r.totalUsd));
    const rawMax = Math.max(...raw.map((r) => r.totalUsd));
    const sampledValues = sampled.map((r) => r.totalUsd);
    expect(Math.min(...sampledValues)).toBeCloseTo(rawMin, 6);
    expect(Math.max(...sampledValues)).toBeCloseTo(rawMax, 6);
    expect([...sampled.map((r) => r.takenAt)].sort((a, b) => a - b)).toEqual(
      sampled.map((r) => r.takenAt),
    );
  }, 20_000);

  it("再加一倍快照,采样行数不再涨", async () => {
    const acc = await accounts(USER).create({ connectorId: "binance", label: "B", creds: "x" });
    const start = 2_000_000;
    await seedManySnapshots(acc.id, 80, start, DAY, (i) => i);
    const first = await snapshotsOf(USER).listTotalsByAccountMinMax(acc.id);
    await seedManySnapshots(acc.id, 80, start + 80 * DAY, DAY, (i) => 80 + i);
    const second = await snapshotsOf(USER).listTotalsByAccountMinMax(acc.id);

    expect(first.length).toBeLessThanOrEqual(HISTORY_MINMAX_BUCKETS * 2);
    expect(second.length).toBeLessThanOrEqual(HISTORY_MINMAX_BUCKETS * 2);
    expect(Math.abs(second.length - first.length)).toBeLessThanOrEqual(4);
  }, 30_000);

  it("listTotalsMinMax:按组合净值时间线降采样,保留组合级极值", async () => {
    const a1 = await accounts(USER).create({ connectorId: "binance", label: "A1", creds: "x" });
    const a2 = await accounts(USER).create({ connectorId: "binance", label: "A2", creds: "x" });
    const other = await accounts(USER).create({ connectorId: "binance", label: "X", creds: "x" });
    const start = 3_000_000;
    // a1 全程 10;a2 前 50 天缺席,第 50 天起 +90 → 组合在 a2 入场时出现尖峰 100。
    await seedManySnapshots(a1.id, 100, start, DAY, () => 10);
    await seedManySnapshots(a2.id, 50, start + 50 * DAY, DAY, () => 90);
    await seedManySnapshots(other.id, 100, start, DAY, () => 999);

    const rows = await snapshotsOf(USER).listTotalsMinMax([a1.id, a2.id]);
    expect(rows.every((r) => r.accountId === a1.id || r.accountId === a2.id)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(HISTORY_MINMAX_BUCKETS * 2 * 2);
    expect(rows.length).toBeGreaterThan(4);

    const portfolioSeries = buildPortfolioTimeline(rows);
    expect(Math.max(...portfolioSeries.map((p) => p.total))).toBe(100);
  }, 40_000);

  it("listTotalsMinMax:重建后每个点都等于真实组合净值(交错时间戳不产生假凹口/尖峰)", async () => {
    const a1 = await accounts(USER).create({ connectorId: "binance", label: "A1", creds: "x" });
    const a2 = await accounts(USER).create({ connectorId: "binance", label: "A2", creds: "x" });
    const start = 5_000_000;
    // 两账户都在变、且 takenAt 交错半步 —— 正是 review 抓的场景:某账户的控制行时刻会成渲染点,
    // 旧实现在那个时刻会把另一账户求和成更旧的值/漏掉。重盖到 kept 时刻后,每点必等于真值。
    await seedManySnapshots(a1.id, 60, start, DAY, (i) => 100 + Math.sin(i / 2) * 40);
    await seedManySnapshots(a2.id, 60, start + DAY / 2, DAY, (i) => 200 + Math.cos(i / 3) * 80);

    const raw = await snapshotsOf(USER).listTotals(); // 全量原始行(仅 a1/a2,beforeEach 已清)
    const sampled = await snapshotsOf(USER).listTotalsMinMax([a1.id, a2.id]);
    const series = buildPortfolioTimeline(sampled);

    expect(series.length).toBeGreaterThan(4);
    for (const p of series) {
      expect(p.total).toBeCloseTo(trueValueAt(raw, p.t), 6);
    }
  }, 40_000);

  it("listTotals:裁窗口时补 carry-in(停更账户不从曲线消失)", async () => {
    const a = await accounts(USER).create({ connectorId: "binance", label: "A", creds: "x" });
    const cold = await accounts(USER).create({ connectorId: "binance", label: "C", creds: "x" });
    await snapshotsOf(USER).write(a.id, { takenAt: 100, totalUsd: 500, balances: [] });
    await snapshotsOf(USER).write(a.id, { takenAt: 1000, totalUsd: 500, balances: [] });
    // cold 最近一张在窗口起点之前 → 没有 carry-in 的话它整条消失。
    await snapshotsOf(USER).write(cold.id, { takenAt: 50, totalUsd: 200, balances: [] });

    const rows = await snapshotsOf(USER).listTotals(500);
    // cold 的起点值被补进来,stamped 到 since=500。
    expect(rows).toContainEqual({ accountId: cold.id, takenAt: 500, totalUsd: 200 });
    // a:窗口前的 100 补成 500,窗口内的 1000 保留。
    expect(
      rows
        .filter((r) => r.accountId === a.id)
        .map((r) => r.takenAt)
        .sort((x, y) => x - y),
    ).toEqual([500, 1000]);
  });

  it("listTotalsMinMax:裁窗口时补 carry-in(停更账户不从曲线消失)", async () => {
    const a = await accounts(USER).create({ connectorId: "binance", label: "A", creds: "x" });
    const cold = await accounts(USER).create({ connectorId: "binance", label: "C", creds: "x" });
    await snapshotsOf(USER).write(a.id, { takenAt: 100, totalUsd: 500, balances: [] });
    await snapshotsOf(USER).write(a.id, { takenAt: 1000, totalUsd: 500, balances: [] });
    await snapshotsOf(USER).write(cold.id, { takenAt: 50, totalUsd: 200, balances: [] });

    const rows = await snapshotsOf(USER).listTotalsMinMax([a.id, cold.id], 500);
    expect(rows.some((r) => r.accountId === cold.id)).toBe(true);
    // 组合净值全程含 cold 的 200(不再偏低)。
    const series = buildPortfolioTimeline(rows);
    expect(series.every((p) => p.total === 700)).toBe(true);
  });

  it("listTotalsByAccount:短窗仍返回原始点(行为不变)", async () => {
    const acc = await accounts(USER).create({ connectorId: "binance", label: "B", creds: "x" });
    await snapshotsOf(USER).write(acc.id, { takenAt: 100, totalUsd: 10, balances: [] });
    await snapshotsOf(USER).write(acc.id, { takenAt: 200, totalUsd: 20, balances: [] });
    await snapshotsOf(USER).write(acc.id, { takenAt: 300, totalUsd: 30, balances: [] });

    expect(await snapshotsOf(USER).listTotalsByAccount(acc.id, 150)).toEqual([
      { takenAt: 200, totalUsd: 20 },
      { takenAt: 300, totalUsd: 30 },
    ]);
  });
});

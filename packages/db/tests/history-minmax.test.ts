import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
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

// 长窗原料(FOL-46 → FOL-92):服务端只在 SQL 里按桶封顶,降采样在浏览器做。这里钉的是
// 「发多少行有上界」+「该在里面的真实观测在里面」—— 形状对不对由浏览器那侧的单测管。
describe("history sampled (FOL-92)", () => {
  it("listSampledTotalsByAccount:每桶 ≤ 4 点、行数与历史长度脱钩,全局极值与首末点保留", async () => {
    const acc = await accounts(USER).create({ connectorId: "binance", label: "B", creds: "x" });
    const start = 1_000_000;
    await seedManySnapshots(acc.id, 120, start, DAY, (i) => 100 + Math.sin(i / 3) * 50);

    const raw = await snapshotsOf(USER).listTotalsByAccount(acc.id);
    const sampled = await snapshotsOf(USER).listSampledTotalsByAccount(acc.id, undefined, 10);

    expect(raw).toHaveLength(120);
    expect(sampled.length).toBeLessThanOrEqual(10 * 4);
    expect(sampled.length).toBeGreaterThan(10);

    const values = (rows: { totalUsd: number }[]) => rows.map((r) => r.totalUsd);
    expect(Math.min(...values(sampled))).toBe(Math.min(...values(raw)));
    expect(Math.max(...values(sampled))).toBe(Math.max(...values(raw)));
    expect(sampled[0]).toEqual(raw[0]);
    expect(sampled.at(-1)).toEqual(raw.at(-1));
    // 每个点都是真实观测,且升序。
    const rawSet = new Set(raw.map((r) => `${r.takenAt}:${r.totalUsd}`));
    expect(sampled.every((r) => rawSet.has(`${r.takenAt}:${r.totalUsd}`))).toBe(true);
    const ts = sampled.map((r) => r.takenAt);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  }, 20_000);

  it("再加一倍快照,采样行数不再涨", async () => {
    const acc = await accounts(USER).create({ connectorId: "binance", label: "B", creds: "x" });
    const start = 2_000_000;
    await seedManySnapshots(acc.id, 80, start, DAY, (i) => i);
    const first = await snapshotsOf(USER).listSampledTotalsByAccount(acc.id, undefined, 10);
    await seedManySnapshots(acc.id, 80, start + 80 * DAY, DAY, (i) => 80 + i);
    const second = await snapshotsOf(USER).listSampledTotalsByAccount(acc.id, undefined, 10);

    expect(first.length).toBeLessThanOrEqual(10 * 4);
    expect(second.length).toBeLessThanOrEqual(10 * 4);
  }, 30_000);

  it("listSampledTotals:每账户每桶一行真实收盘,只含请求的账户;组合的最后一点是真值", async () => {
    const a1 = await accounts(USER).create({ connectorId: "binance", label: "A1", creds: "x" });
    const a2 = await accounts(USER).create({ connectorId: "binance", label: "A2", creds: "x" });
    const other = await accounts(USER).create({ connectorId: "binance", label: "X", creds: "x" });
    const start = 3_000_000;
    await seedManySnapshots(a1.id, 100, start, DAY, (i) => 10 + (i % 5));
    await seedManySnapshots(a2.id, 50, start + 50 * DAY, DAY, () => 90);
    await seedManySnapshots(other.id, 100, start, DAY, () => 999);

    const raw = (await snapshotsOf(USER).listTotals()).filter((r) => r.accountId !== other.id);
    const rows = await snapshotsOf(USER).listSampledTotals([a1.id, a2.id], undefined, 10);
    expect(rows.every((r) => r.accountId === a1.id || r.accountId === a2.id)).toBe(true);
    for (const id of [a1.id, a2.id]) {
      expect(rows.filter((r) => r.accountId === id).length).toBeLessThanOrEqual(10);
    }
    const rawSet = new Set(raw.map((r) => `${r.accountId}:${r.takenAt}:${r.totalUsd}`));
    expect(rows.every((r) => rawSet.has(`${r.accountId}:${r.takenAt}:${r.totalUsd}`))).toBe(true);

    const series = buildPortfolioTimeline(rows);
    const last = series.at(-1);
    expect(last?.total).toBe(trueValueAt(raw, last?.t ?? 0));
    // a2 入场之后组合才有 +90 —— 这一段在曲线里。
    expect(Math.max(...series.map((p) => p.total))).toBeGreaterThanOrEqual(100);
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

  it("listSampledTotals:裁窗口时补 carry-in(停更账户不从曲线消失)", async () => {
    const a = await accounts(USER).create({ connectorId: "binance", label: "A", creds: "x" });
    const cold = await accounts(USER).create({ connectorId: "binance", label: "C", creds: "x" });
    await snapshotsOf(USER).write(a.id, { takenAt: 100, totalUsd: 500, balances: [] });
    await snapshotsOf(USER).write(a.id, { takenAt: 1000, totalUsd: 500, balances: [] });
    await snapshotsOf(USER).write(cold.id, { takenAt: 50, totalUsd: 200, balances: [] });

    const rows = await snapshotsOf(USER).listSampledTotals([a.id, cold.id], 500);
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

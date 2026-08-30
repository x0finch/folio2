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

  it("listTotalsMinMax:按账户各自降采样,只含指定账户", async () => {
    const a1 = await accounts(USER).create({ connectorId: "manual", label: "A1", creds: "x" });
    const a2 = await accounts(USER).create({ connectorId: "manual", label: "A2", creds: "x" });
    const other = await accounts(USER).create({ connectorId: "manual", label: "X", creds: "x" });
    await seedManySnapshots(a1.id, 100, 3_000_000, DAY, (i) => 10 + i);
    await seedManySnapshots(a2.id, 100, 3_000_000, DAY, (i) => 20 + i);
    await seedManySnapshots(other.id, 100, 3_000_000, DAY, () => 999);

    const rows = await snapshotsOf(USER).listTotalsMinMax([a1.id, a2.id]);
    expect(rows.every((r) => r.accountId === a1.id || r.accountId === a2.id)).toBe(true);
    expect(rows.length).toBeLessThanOrEqual(HISTORY_MINMAX_BUCKETS * 2 * 2);
    expect(rows.length).toBeGreaterThan(4);
  }, 40_000);

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

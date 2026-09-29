import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { beforeEach, describe, expect, it } from "vitest";
import { getDb } from "../src/connect";
import { HISTORY_SAMPLED_BUCKETS } from "../src/domains/history-minmax";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

const snapshotsOf = forDomain((db) => db.snapshots);
const accounts = forDomain((db) => db.accounts);

const USER = "user-minmax";
const HOUR = 3_600_000;
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

// 每天一张快照直接灌 SQL(几百行,走 write 太慢),再跑迁移里那条回填把日汇总补上 —— 与生产
// 迁移同一条路(同 `daily-totals.test.ts` 的 `seedHourly`)。
async function seedDaily(accountId: string, startAt: number, values: number[]) {
  const stmt = env.DB.prepare(
    "INSERT INTO snapshots (id, account_id, taken_at, total_usd) VALUES (?, ?, ?, ?)",
  );
  await env.DB.batch(
    values.map((v, i) => stmt.bind(`${accountId}-${i}`, accountId, startAt + i * DAY, v)),
  );
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.includes("account_daily_totals"));
  const backfill = migration?.queries.find((q) => q.includes("INSERT OR REPLACE"));
  await env.DB.prepare(backfill as string).run();
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

  it("listSampledTotals:只含请求的账户、每账户行数有上界,组合的极值与最后一点都是真值", async () => {
    const a1 = await accounts(USER).create({ connectorId: "binance", label: "A1", creds: "x" });
    const a2 = await accounts(USER).create({ connectorId: "binance", label: "A2", creds: "x" });
    const other = await accounts(USER).create({ connectorId: "binance", label: "X", creds: "x" });
    const start = 3_000_000;
    // a1 在 10 上下;a2 前 50 天缺席,第 50 天起 +90 → 组合的最高点是 a2 入场后 a1 的峰 14 + 90。
    await seedDaily(
      a1.id,
      start,
      Array.from({ length: 100 }, (_, i) => 10 + (i % 5)),
    );
    await seedDaily(
      a2.id,
      start + 50 * DAY,
      Array.from({ length: 50 }, () => 90),
    );
    await seedDaily(
      other.id,
      start,
      Array.from({ length: 100 }, () => 999),
    );

    const raw = (await snapshotsOf(USER).listTotals()).filter((r) => r.accountId !== other.id);
    const rows = await snapshotsOf(USER).listSampledTotals([a1.id, a2.id], undefined, 10);
    expect(rows.every((r) => r.accountId === a1.id || r.accountId === a2.id)).toBe(true);
    for (const id of [a1.id, a2.id]) {
      expect(rows.filter((r) => r.accountId === id).length).toBeLessThanOrEqual(3 * 10 + 1);
    }

    const series = buildPortfolioTimeline(rows);
    const last = series.at(-1);
    expect(last?.total).toBe(trueValueAt(raw, last?.t ?? 0));
    expect(Math.max(...series.map((p) => p.total))).toBe(104);
    expect(Math.min(...series.map((p) => p.total))).toBe(10);
  }, 40_000);

  it("listSampledTotals:重建后每个点都等于真实组合净值(交错时间戳不产生假凹口 / 尖峰)", async () => {
    const a1 = await accounts(USER).create({ connectorId: "binance", label: "A1", creds: "x" });
    const a2 = await accounts(USER).create({ connectorId: "binance", label: "A2", creds: "x" });
    const start = 5_000_000;
    // 两账户都在变、且 takenAt 交错半天:某账户的行若按它自己的时刻发出,那一刻另一账户会被求成
    // 更旧的值。发出的行都落在候选时刻上、每个候选时刻各账户的值都在 → 每点必等于真值。
    await seedDaily(
      a1.id,
      start,
      Array.from({ length: 60 }, (_, i) => 100 + Math.round(Math.sin(i / 2) * 40)),
    );
    await seedDaily(
      a2.id,
      start + DAY / 2,
      Array.from({ length: 60 }, (_, i) => 200 + Math.round(Math.cos(i / 3) * 80)),
    );

    const raw = await snapshotsOf(USER).listTotals();
    const series = buildPortfolioTimeline(
      await snapshotsOf(USER).listSampledTotals([a1.id, a2.id], undefined, 5),
    );
    const truth = buildPortfolioTimeline(raw);

    expect(series.length).toBeGreaterThan(4);
    for (const p of series) expect(p.total).toBe(trueValueAt(raw, p.t));
    expect(Math.min(...series.map((p) => p.total))).toBe(Math.min(...truth.map((p) => p.total)));
    expect(Math.max(...series.map((p) => p.total))).toBe(Math.max(...truth.map((p) => p.total)));
  }, 40_000);

  // review #2:一天的闪崩落在多天一桶的中间 —— 上一版「每账户每桶留最后一个收盘」会把它整个丢掉。
  it("单日 40% 闪崩落在多天一桶的中间,1 年与全部窗口里都还在", async () => {
    const a1 = await accounts(USER).create({ connectorId: "binance", label: "A1", creds: "x" });
    const a2 = await accounts(USER).create({ connectorId: "binance", label: "A2", creds: "x" });
    const start = 7 * DAY;
    const DAYS = 420;
    const CRASH = 203;
    const wiggle = (i: number) => (i * 37) % 11;
    await seedDaily(
      a1.id,
      start,
      Array.from({ length: DAYS }, (_, i) => (i === CRASH ? 600 : 1000 + wiggle(i))),
    );
    await seedDaily(
      a2.id,
      start + HOUR,
      Array.from({ length: DAYS }, (_, i) => (i === CRASH ? 300 : 500 + wiggle(i + 3))),
    );
    const raw = await snapshotsOf(USER).listTotals();
    const crashTotal = 600 + 300;

    const now = start + DAYS * DAY;
    for (const since of [undefined, now - 365 * DAY]) {
      for (const buckets of [10, undefined]) {
        const rows = await snapshotsOf(USER).listSampledTotals([a1.id, a2.id], since, buckets);
        const cap = 3 * (buckets ?? HISTORY_SAMPLED_BUCKETS) + 1;
        for (const id of [a1.id, a2.id]) {
          expect(rows.filter((r) => r.accountId === id).length).toBeLessThanOrEqual(cap);
        }
        const series = buildPortfolioTimeline(rows);
        expect(Math.min(...series.map((p) => p.total))).toBe(crashTotal);
        for (const p of series) expect(p.total).toBe(trueValueAt(raw, p.t));
      }
    }
  }, 60_000);

  // review R2-#5:手记账户不在表里,由调用方把它的阶梯观测(`extra`)一起递进来。它必须进同一条组合
  // 时间线 —— 以前手记行按自己的时刻另发,浏览器在两个候选时刻之间的手记时刻上会把 synced 账户那次
  // 单日闪崩一直带着,闪崩看上去就成了好几天的深坑。
  it("listSampledTotals + extra(手记):每个点都是真值,闪崩还在,手记也封顶", async () => {
    const synced = await accounts(USER).create({ connectorId: "binance", label: "S", creds: "x" });
    const MANUAL = "manual-acc";
    const start = 9 * DAY;
    const DAYS = 420;
    const CRASH = 203;
    await seedDaily(
      synced.id,
      start,
      Array.from({ length: DAYS }, (_, i) => (i === CRASH ? 400 : 1000 + ((i * 37) % 11))),
    );
    // 手记账户:日末一行、值在变(错开半天,落在 synced 的候选之间)。
    const manual = Array.from({ length: DAYS }, (_, i) => ({
      accountId: MANUAL,
      takenAt: start + DAY / 2 + i * DAY,
      totalUsd: 300 + ((i * 13) % 17),
    }));
    const raw = [...(await snapshotsOf(USER).listTotals()), ...manual];
    const truth = buildPortfolioTimeline(raw);

    const now = start + DAYS * DAY;
    for (const since of [undefined, now - 365 * DAY]) {
      for (const buckets of [10, undefined]) {
        const inWindow =
          since == null
            ? manual
            : [
                { ...manual.filter((r) => r.takenAt < since).at(-1), takenAt: since },
                ...manual.filter((r) => r.takenAt >= since),
              ].map((r) => ({ accountId: MANUAL, takenAt: r.takenAt, totalUsd: r.totalUsd ?? 0 }));
        const rows = await snapshotsOf(USER).listSampledTotals(
          [synced.id],
          since,
          buckets,
          inWindow,
        );
        const cap = 3 * (buckets ?? HISTORY_SAMPLED_BUCKETS) + 1;
        for (const id of [synced.id, MANUAL]) {
          const mine = rows.filter((r) => r.accountId === id);
          expect(mine.length).toBeGreaterThan(0);
          expect(mine.length).toBeLessThanOrEqual(cap);
        }
        const series = buildPortfolioTimeline(rows);
        for (const p of series) expect(p.total).toBe(trueValueAt(raw, p.t));
        const crashTotal = Math.min(
          ...truth.filter((p) => since == null || p.t >= since).map((p) => p.total),
        );
        expect(Math.min(...series.map((p) => p.total))).toBe(crashTotal);
      }
    }
  }, 60_000);

  it("listSampledTotals:只有 extra(纯手记组合)也照样挑候选、发回", async () => {
    const rows = await snapshotsOf(USER).listSampledTotals([], undefined, 5, [
      { accountId: "m1", takenAt: 1_000, totalUsd: 10 },
      { accountId: "m1", takenAt: 2_000, totalUsd: 10 },
      { accountId: "m1", takenAt: 3_000, totalUsd: 30 },
      { accountId: "m2", takenAt: 1_500, totalUsd: 5 },
    ]);
    // 值不变的相邻行去掉;其余每个点都是真值。
    expect(buildPortfolioTimeline(rows)).toEqual([
      { t: 1_000, total: 10 },
      { t: 1_500, total: 15 },
      { t: 3_000, total: 35 },
    ]);
  });

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

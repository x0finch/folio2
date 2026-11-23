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

// True portfolio value at t = sum of each account's latest row <= t (from all raw rows; the reference for closure assertions).
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

// One snapshot per day seeded via SQL (hundreds of rows; `write` is too slow), then the migration's backfill fills the daily rollup, like production.
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

// Long-window input: the server caps per bucket in SQL and downsampling happens in the browser. These pin the row-count upper bound and that real observations are included.
describe("history sampled", () => {
  it("listSampledTotalsByAccount: at most 4 points per bucket, row count independent of history length, global extremes and first/last kept", async () => {
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
    // Every point is a real observation, ascending.
    const rawSet = new Set(raw.map((r) => `${r.takenAt}:${r.totalUsd}`));
    expect(sampled.every((r) => rawSet.has(`${r.takenAt}:${r.totalUsd}`))).toBe(true);
    const ts = sampled.map((r) => r.takenAt);
    expect([...ts].sort((a, b) => a - b)).toEqual(ts);
  }, 20_000);

  it("doubling the snapshots does not grow the sampled row count", async () => {
    const acc = await accounts(USER).create({ connectorId: "binance", label: "B", creds: "x" });
    const start = 2_000_000;
    await seedManySnapshots(acc.id, 80, start, DAY, (i) => i);
    const first = await snapshotsOf(USER).listSampledTotalsByAccount(acc.id, undefined, 10);
    await seedManySnapshots(acc.id, 80, start + 80 * DAY, DAY, (i) => 80 + i);
    const second = await snapshotsOf(USER).listSampledTotalsByAccount(acc.id, undefined, 10);

    expect(first.length).toBeLessThanOrEqual(10 * 4);
    // Raw rows double (80 to 160) but emitted rows don't grow: compare before and after, not just each under the cap.
    expect(second.length).toBeLessThanOrEqual(first.length);
  }, 30_000);

  it("listSampledTotals: only requested accounts, bounded rows per account, portfolio extremes and last point are real", async () => {
    const a1 = await accounts(USER).create({ connectorId: "binance", label: "A1", creds: "x" });
    const a2 = await accounts(USER).create({ connectorId: "binance", label: "A2", creds: "x" });
    const other = await accounts(USER).create({ connectorId: "binance", label: "X", creds: "x" });
    const start = 3_000_000;
    // a1 hovers around 10; a2 is absent for 50 days then +90, so the portfolio peak is a1's peak 14 + 90 after a2 enters.
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

  it("listSampledTotals: after rebuild every point equals the real portfolio value (interleaved timestamps produce no false notches or spikes)", async () => {
    const a1 = await accounts(USER).create({ connectorId: "binance", label: "A1", creds: "x" });
    const a2 = await accounts(USER).create({ connectorId: "binance", label: "A2", creds: "x" });
    const start = 5_000_000;
    // Both accounts change with takenAt interleaved by half a day: a row emitted at its own time would make the other account stale. Emitting only at candidate times with every account's value gives true values.
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

  // A one-day crash in the middle of a multi-day bucket must not be dropped by keeping only each bucket's last close.
  it("a single-day 40% crash mid-bucket survives in the 1-year and all windows", async () => {
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

  // Manual accounts aren't in the table: the caller passes their step observations (`extra`), which must join the same portfolio timeline, or a synced account's crash would be carried across days.
  it("listSampledTotals + extra (manual): every point is real, the crash survives, manual is capped too", async () => {
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
    // Manual account: one row at day end, changing value (offset half a day, between the synced candidates).
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

  // Invariant (seeded random portfolios, real D1): account count, span, offsets, crashes, window and bucket count all vary. Per round: rows per account <= 3 x buckets + 1; every rebuilt point is a real portfolio value; ascending; first/last and global min/max in the window are present. Integer values so summation order can't look like a bug.
  it("random portfolios: every point real, first/last and extremes present, bounded rows", async () => {
    let seed = 2024;
    const rand = () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed / 2 ** 31;
    };
    const int = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
    let checked = 0;
    let windowed = 0;
    for (let round = 0; round < 10; round++) {
      await resetUser(USER);
      const start = int(1, 1000) * DAY;
      const ids: string[] = [];
      for (let k = int(1, 3); k > 0; k--) {
        const acc = await accounts(USER).create({ connectorId: "binance", label: "A", creds: "x" });
        ids.push(acc.id);
        let v = int(100, 10_000);
        const values = Array.from({ length: int(5, 90) }, () => {
          const r = rand();
          v = r < 0.3 ? v : Math.max(0, v + int(-500, 500));
          return r > 0.95 ? int(0, 50) : v; // occasional single-day crash
        });
        await seedDaily(acc.id, start + int(0, 40) * DAY + int(0, 23) * HOUR, values);
      }
      const buckets = int(2, 15);
      const raw = await snapshotsOf(USER).listTotals();
      const lastT = Math.max(...raw.map((r) => r.takenAt));
      const since = rand() < 0.5 ? undefined : start + int(0, 60) * DAY + int(0, 23) * HOUR;
      if (since != null && since > lastT) continue;

      checked++;
      if (since != null) windowed++;
      const rows = await snapshotsOf(USER).listSampledTotals(ids, since, buckets);
      for (const id of ids) {
        expect(rows.filter((r) => r.accountId === id).length).toBeLessThanOrEqual(3 * buckets + 1);
      }
      const series = buildPortfolioTimeline(rows);
      // Real portfolio timeline in the window: each event time in it, plus the window start when some account has an earlier observation.
      const truth = buildPortfolioTimeline(raw).filter((p) => since == null || p.t >= since);
      if (since != null && raw.some((r) => r.takenAt < since) && truth[0]?.t !== since) {
        truth.unshift({ t: since, total: trueValueAt(raw, since) });
      }

      for (const p of series) expect(p.total).toBe(trueValueAt(raw, p.t));
      for (let i = 1; i < series.length; i++) expect(series[i].t).toBeGreaterThan(series[i - 1].t);
      expect(series[0].t).toBe(truth[0].t);
      expect(series.at(-1)?.t).toBe(truth.at(-1)?.t);
      const totals = (xs: { total: number }[]) => xs.map((p) => p.total);
      expect(Math.min(...totals(series))).toBe(Math.min(...totals(truth)));
      expect(Math.max(...totals(series))).toBe(Math.max(...totals(truth)));
    }
    // Make sure `continue` can't silently skip every round: both the full and trimmed windows ran.
    expect(checked).toBeGreaterThanOrEqual(8);
    expect(windowed).toBeGreaterThanOrEqual(3);
  }, 60_000);

  it("listSampledTotals: extra only (pure manual portfolio) still picks candidates and returns them", async () => {
    const rows = await snapshotsOf(USER).listSampledTotals([], undefined, 5, [
      { accountId: "m1", takenAt: 1_000, totalUsd: 10 },
      { accountId: "m1", takenAt: 2_000, totalUsd: 10 },
      { accountId: "m1", takenAt: 3_000, totalUsd: 30 },
      { accountId: "m2", takenAt: 1_500, totalUsd: 5 },
    ]);
    // Adjacent rows with equal values are dropped; every other point is real.
    expect(buildPortfolioTimeline(rows)).toEqual([
      { t: 1_000, total: 10 },
      { t: 1_500, total: 15 },
      { t: 3_000, total: 35 },
    ]);
  });

  it("listTotals: trimming the window adds a carry-in (stale accounts don't vanish from the curve)", async () => {
    const a = await accounts(USER).create({ connectorId: "binance", label: "A", creds: "x" });
    const cold = await accounts(USER).create({ connectorId: "binance", label: "C", creds: "x" });
    await snapshotsOf(USER).write(a.id, { takenAt: 100, totalUsd: 500, balances: [] });
    await snapshotsOf(USER).write(a.id, { takenAt: 1000, totalUsd: 500, balances: [] });
    // cold's latest row is before the window start: without carry-in it would vanish.
    await snapshotsOf(USER).write(cold.id, { takenAt: 50, totalUsd: 200, balances: [] });

    const rows = await snapshotsOf(USER).listTotals(500);
    // cold's start value is carried in, stamped at since=500.
    expect(rows).toContainEqual({ accountId: cold.id, takenAt: 500, totalUsd: 200 });
    // a: the pre-window 100 becomes 500; the in-window 1000 stays.
    expect(
      rows
        .filter((r) => r.accountId === a.id)
        .map((r) => r.takenAt)
        .sort((x, y) => x - y),
    ).toEqual([500, 1000]);
  });

  it("listSampledTotals: trimming the window adds a carry-in (stale accounts don't vanish from the curve)", async () => {
    const a = await accounts(USER).create({ connectorId: "binance", label: "A", creds: "x" });
    const cold = await accounts(USER).create({ connectorId: "binance", label: "C", creds: "x" });
    await snapshotsOf(USER).write(a.id, { takenAt: 100, totalUsd: 500, balances: [] });
    await snapshotsOf(USER).write(a.id, { takenAt: 1000, totalUsd: 500, balances: [] });
    await snapshotsOf(USER).write(cold.id, { takenAt: 50, totalUsd: 200, balances: [] });

    const rows = await snapshotsOf(USER).listSampledTotals([a.id, cold.id], 500);
    expect(rows.some((r) => r.accountId === cold.id)).toBe(true);
    // The portfolio value includes cold's 200 throughout (no longer low).
    const series = buildPortfolioTimeline(rows);
    expect(series.every((p) => p.total === 700)).toBe(true);
  });
});

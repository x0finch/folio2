import { env } from "cloudflare:test";
import { eq } from "drizzle-orm";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { provideDbClient } from "../src/client";
import { getDb } from "../src/connect";
import { provideCurrentUser } from "../src/current-user";
import { Database, type DbRequest } from "../src/database";
import { user } from "../src/schema/auth";
import { forDomain } from "./effect";

// Daily rollup: maintained in the same batch as snapshots, backfilled by the migration, and read by long windows instead of scanning snapshots. Needs real D1: batch ordering (later statements see earlier writes), SQLite upsert `excluded`, and window-function backfill.

const snapshotsOf = forDomain((db) => db.snapshots);
const accountsOf = forDomain((db) => db.accounts);

const USER = "user-daily-totals";
const HOUR = 3_600_000;
const DAY = 86_400_000;
// A UTC midnight (the start of the day containing 1_800_000_000_000).
const D0 = Math.floor(1_800_000_000_000 / DAY) * DAY;

interface DailyRow {
  account_id: string;
  day: number;
  open_usd: number;
  open_at: number;
  min_usd: number;
  min_at: number;
  max_usd: number;
  max_at: number;
  close_usd: number;
  close_at: number;
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

beforeEach(async () => {
  await resetUser(USER);
});

const account = (label: string) =>
  accountsOf(USER)
    .create({ connectorId: "bitcoin", label, creds: null })
    .then((a) => a.id);

const write = (accountId: string, takenAt: number, totalUsd: number, collapse = false) =>
  snapshotsOf(USER).write(
    accountId,
    {
      takenAt,
      totalUsd,
      balances: [{ amount: 1, usdValue: totalUsd, kind: "spot", tokenId: "t" }],
    },
    { collapseSameHour: collapse },
  );

/** All of this user's rollup rows, sorted by (account, day). */
async function dailyRows(): Promise<DailyRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT d.* FROM account_daily_totals d JOIN accounts a ON a.id = d.account_id
     WHERE a.user_id = ? ORDER BY d.account_id, d.day`,
  )
    .bind(USER)
    .all<DailyRow>();
  return results;
}

/** Reference: computed directly from snapshots by definition (a third implementation, independent of the write side and the backfill). */
async function expectedFromSnapshots(): Promise<DailyRow[]> {
  const { results } = await env.DB.prepare(
    `SELECT s.account_id, s.taken_at, s.total_usd, s.rowid AS rid FROM snapshots s
     JOIN accounts a ON a.id = s.account_id WHERE a.user_id = ?`,
  )
    .bind(USER)
    .all<{ account_id: string; taken_at: number; total_usd: number; rid: number }>();
  const groups = new Map<string, typeof results>();
  for (const r of results) {
    const key = `${r.account_id}|${Math.floor(r.taken_at / DAY) * DAY}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: DailyRow[] = [];
  for (const [key, rows] of groups) {
    const [accountId, day] = key.split("|");
    const byTime = [...rows].sort((a, b) => a.taken_at - b.taken_at || a.rid - b.rid);
    const low = [...rows].sort(
      (a, b) => a.total_usd - b.total_usd || a.taken_at - b.taken_at || a.rid - b.rid,
    )[0];
    const high = [...rows].sort(
      (a, b) => b.total_usd - a.total_usd || a.taken_at - b.taken_at || a.rid - b.rid,
    )[0];
    const first = byTime[0];
    const last = byTime[byTime.length - 1];
    out.push({
      account_id: accountId,
      day: Number(day),
      open_usd: first.total_usd,
      open_at: first.taken_at,
      min_usd: low.total_usd,
      min_at: low.taken_at,
      max_usd: high.total_usd,
      max_at: high.taken_at,
      close_usd: last.total_usd,
      close_at: last.taken_at,
    });
  }
  return out.sort((a, b) => a.account_id.localeCompare(b.account_id) || a.day - b.day);
}

describe("maintained on snapshot write", () => {
  it("appends arriving out of order: open/min/max/close land in place", async () => {
    const acc = await account("a");
    await write(acc, D0 + 10 * HOUR, 150);
    await write(acc, D0 + 2 * HOUR, 120); // earlier: becomes open
    await write(acc, D0 + 20 * HOUR, 130); // latest: close
    await write(acc, D0 + 5 * HOUR, 90); // lowest
    await write(acc, D0 + 15 * HOUR, 200); // highest
    await write(acc, D0 + DAY + HOUR, 1); // next day, its own row

    expect(await dailyRows()).toEqual([
      {
        account_id: acc,
        day: D0,
        open_usd: 120,
        open_at: D0 + 2 * HOUR,
        min_usd: 90,
        min_at: D0 + 5 * HOUR,
        max_usd: 200,
        max_at: D0 + 15 * HOUR,
        close_usd: 130,
        close_at: D0 + 20 * HOUR,
      },
      {
        account_id: acc,
        day: D0 + DAY,
        open_usd: 1,
        open_at: D0 + DAY + HOUR,
        min_usd: 1,
        min_at: D0 + DAY + HOUR,
        max_usd: 1,
        max_at: D0 + DAY + HOUR,
        close_usd: 1,
        close_at: D0 + DAY + HOUR,
      },
    ]);
  });

  it("when collapseSameHour replaces that day's high, the whole day is recomputed and the old extreme leaves", async () => {
    const acc = await account("collapse");
    await write(acc, D0 + 3 * HOUR, 100, true);
    await write(acc, D0 + 9 * HOUR + 60_000, 500, true); // the day's high
    await write(acc, D0 + 12 * HOUR, 110, true);
    // Syncing the same hour again: the 500 row is deleted and replaced by 105. An incremental compare would leave 500 as max, so recompute.
    await write(acc, D0 + 9 * HOUR + 30 * 60_000, 105, true);

    const [row] = await dailyRows();
    expect(row.max_usd).toBe(110);
    expect(row.max_at).toBe(D0 + 12 * HOUR);
    expect(row.min_usd).toBe(100);
    expect(row.close_usd).toBe(110);
    expect(await dailyRows()).toEqual(await expectedFromSnapshots());
  });

  it("when collapseSameHour replaces the day's only / last snapshot, close follows", async () => {
    const acc = await account("only");
    await write(acc, D0 + 23 * HOUR + 1000, 300, true);
    await write(acc, D0 + 23 * HOUR + 2000, 250, true);

    expect(await dailyRows()).toEqual([
      {
        account_id: acc,
        day: D0,
        open_usd: 250,
        open_at: D0 + 23 * HOUR + 2000,
        min_usd: 250,
        min_at: D0 + 23 * HOUR + 2000,
        max_usd: 250,
        max_at: D0 + 23 * HOUR + 2000,
        close_usd: 250,
        close_at: D0 + 23 * HOUR + 2000,
      },
    ]);
  });

  it("deleting an account removes its rollup too (FK cascade)", async () => {
    const acc = await account("gone");
    await write(acc, D0 + HOUR, 10);
    expect(await dailyRows()).toHaveLength(1);
    await accountsOf(USER).remove(acc);
    expect(await dailyRows()).toHaveLength(0);
  });
});

describe("migration backfill", () => {
  it("rows recomputed by the backfill statement match the write side's maintained rows verbatim", async () => {
    const a = await account("a");
    const b = await account("b");
    // A mix: append + collapse, out of order, equal-value ties, across days, same-instant ties.
    for (let h = 0; h < 50; h++) {
      await write(a, D0 + h * HOUR + 60_000, 100 + ((h * 37) % 23), h % 2 === 0);
    }
    await write(a, D0 + 4 * HOUR + 60_000, 100 + ((4 * 37) % 23), true); // same value again in the same hour
    await write(b, D0 + 30 * HOUR, 50);
    await write(b, D0 + 30 * HOUR, 60); // same-instant tie: the later write is close
    await write(b, D0 + 26 * HOUR, 60); // same as the highest, earlier: max_at takes it
    await write(b, D0 + 2 * HOUR, 70);

    const maintained = await dailyRows();
    expect(maintained).toEqual(await expectedFromSnapshots());

    // Takes the real backfill statement from the migration file (not a copy, which would drift).
    const migration = env.TEST_MIGRATIONS.find((m) => m.name.includes("account_daily_totals"));
    const backfill = migration?.queries.find((q) => q.includes("INSERT OR REPLACE"));
    expect(backfill).toBeDefined();

    await env.DB.prepare(
      "DELETE FROM account_daily_totals WHERE account_id IN (SELECT id FROM accounts WHERE user_id = ?)",
    )
      .bind(USER)
      .run();
    expect(await dailyRows()).toHaveLength(0);
    await env.DB.prepare(backfill as string).run();

    expect(await dailyRows()).toEqual(maintained);
  }, 30_000);
});

interface Recorded {
  sql: string;
  params: unknown[];
}

// Pass-through D1 binding recording each statement (as in snapshot-latest-rows-read.test.ts).
function recordingD1(db: D1Database, log: Recorded[]): D1Database {
  const passthrough = <T extends object>(target: T, key: string | symbol): unknown => {
    const v = Reflect.get(target, key);
    return typeof v === "function" ? v.bind(target) : v;
  };
  return new Proxy(db, {
    get(target, key) {
      if (key !== "prepare") return passthrough(target, key);
      return (sql: string) => {
        const entry: Recorded = { sql, params: [] };
        log.push(entry);
        const stmt = target.prepare(sql);
        return new Proxy(stmt, {
          get(s, k) {
            if (k !== "bind") return passthrough(s, k);
            return (...params: unknown[]) => {
              entry.params = params;
              return s.bind(...params);
            };
          },
        });
      };
    },
  });
}

async function recorded<A>(
  pick: (s: Database["Service"]["snapshots"]) => Effect.Effect<A, unknown, DbRequest>,
): Promise<{ result: A; statements: Recorded[] }> {
  const statements: Recorded[] = [];
  const result = await Effect.runPromise(
    Effect.flatMap(Database, (db) => pick(db.snapshots)).pipe(
      Effect.provide(Database.layer),
      provideCurrentUser(USER),
      provideDbClient({ DB: recordingD1(env.DB, statements) }),
      Effect.orDie,
    ),
  );
  return { result, statements };
}

async function rowsRead(stmts: Recorded[]): Promise<number> {
  let n = 0;
  for (const s of stmts) {
    const { meta } = await env.DB.prepare(s.sql)
      .bind(...s.params)
      .all();
    n += meta.rows_read;
  }
  return n;
}

async function plan(stmts: Recorded[]): Promise<string[]> {
  const out: string[] = [];
  for (const s of stmts) {
    const { results } = await env.DB.prepare(`EXPLAIN QUERY PLAN ${s.sql}`)
      .bind(...s.params)
      .all<{ detail: string }>();
    out.push(...results.map((r) => r.detail));
  }
  return out;
}

// Hourly snapshots seeded via SQL (thousands of rows; `write` is too slow), then the backfill fills the rollup, like the production migration.
async function seedHourly(accountIds: string[], fromHour: number, toHour: number): Promise<void> {
  for (const id of accountIds) {
    await env.DB.prepare(
      `INSERT INTO snapshots (id, account_id, taken_at, total_usd)
       WITH RECURSIVE n(i) AS (SELECT ? UNION ALL SELECT i + 1 FROM n WHERE i + 1 < ?)
       SELECT ? || '-' || n.i, ?, ? + n.i * ?, 1000 + (n.i * 7919) % 500 FROM n`,
    )
      .bind(fromHour, toHour, id, id, D0, HOUR)
      .run();
  }
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.includes("account_daily_totals"));
  const backfill = migration?.queries.find((q) => q.includes("INSERT OR REPLACE"));
  await env.DB.prepare(backfill as string).run();
}

describe("long windows read the rollup, not snapshots", () => {
  const ACCOUNTS = 3;
  const WINDOW_DAYS = 30;

  it("30-day window: history 60 to 400 days, rows read unchanged; no full snapshot scan in the statements", async () => {
    const ids: string[] = [];
    for (let i = 0; i < ACCOUNTS; i++) ids.push(await account(`A${i}`));

    const measure = async (historyDays: number) => {
      const now = D0 + historyDays * DAY;
      const since = now - WINDOW_DAYS * DAY;
      const portfolio = await recorded((s) => s.listDailyTotals(ids, since));
      const sampled = await recorded((s) => s.listSampledTotals(ids, since));
      const single = await recorded((s) => s.listDailyTotalsByAccount(ids[0], since));
      const singleSampled = await recorded((s) => s.listSampledTotalsByAccount(ids[0], since));
      const all = { portfolio, sampled, single, singleSampled };
      // Measure reads here: the window has only a lower bound, so after seeding more history the "small" set wouldn't be the same window.
      const reads = {} as Record<keyof typeof all, number>;
      for (const k of Object.keys(all) as (keyof typeof all)[]) {
        reads[k] = await rowsRead(all[k].statements);
      }
      return { ...all, reads };
    };

    await seedHourly(ids, 0, 60 * 24);
    const small = await measure(60);
    await seedHourly(ids, 60 * 24, 400 * 24);
    const large = await measure(400);

    for (const k of ["portfolio", "sampled", "single", "singleSampled"] as const) {
      expect(large.reads[k]).toBe(small.reads[k]);
      const details = await plan(large[k].statements);
      // The snapshot table may only be point-looked-up by (account_id, taken_at) index (carry-in), never SCANned.
      expect(details.some((d) => /^SCAN (snapshots|s)\b/.test(d))).toBe(false);
    }
    // Portfolio daily line: at most 1 row per account per day plus one carry-in row.
    expect(large.portfolio.result.length).toBeLessThanOrEqual(ACCOUNTS * (WINDOW_DAYS + 2));
    // Single-account daily line: at most 4 points per day.
    expect(large.single.result.length).toBeLessThanOrEqual(4 * (WINDOW_DAYS + 1));
    // For a 30-day window over 400 days of history, reads are far below the hourly snapshot count.
    expect(large.reads.portfolio).toBeLessThan(ACCOUNTS * WINDOW_DAYS * 24);
  }, 120_000);
});

/** Portfolio step reconstruction (same semantics as apps/web buildPortfolioHistory). */
function timeline(rows: readonly { accountId: string; takenAt: number; totalUsd: number }[]) {
  const sorted = [...rows].sort((a, b) => a.takenAt - b.takenAt);
  const latest = new Map<string, number>();
  const out: { t: number; total: number }[] = [];
  for (let i = 0; i < sorted.length; i++) {
    latest.set(sorted[i].accountId, sorted[i].totalUsd);
    if (i + 1 < sorted.length && sorted[i + 1].takenAt === sorted[i].takenAt) continue;
    let total = 0;
    for (const v of latest.values()) total += v;
    out.push({ t: sorted[i].takenAt, total });
  }
  return out;
}

/** Keeps each UTC day's last point (matches apps/web `toDailySeries` over a 30-day span). */
const lastPerDay = (points: readonly { t: number; total: number }[]) => {
  const m = new Map<number, { t: number; total: number }>();
  for (const p of points) m.set(Math.floor(p.t / DAY), p);
  return [...m.values()];
};

describe("golden: daily rollup vs hourly snapshots", () => {
  it("portfolio 30 days: each day's close matches the hourly rebuild point by point; single account 1 year: extremes and endpoints match", async () => {
    const a = await account("a");
    const b = await account("b");
    const cold = await account("cold");
    // a / b hourly for 40 days with varying values; cold has one snapshot before the window (the carry-in path). b joins 3 days later.
    for (let h = 0; h < 40 * 24; h += 1) {
      await write(a, D0 + h * HOUR + 60_000, 1000 + Math.round(Math.sin(h / 7) * 300), true);
      if (h >= 72) {
        await write(b, D0 + h * HOUR + 60_000, 500 + Math.round(Math.cos(h / 5) * 120), true);
      }
    }
    await write(cold, D0 - 5 * DAY, 777, true);

    const now = D0 + 40 * DAY;
    const since = now - 30 * DAY + 5 * HOUR; // window start falls mid-day
    const ids = [a, b, cold];

    const hourly = await snapshotsOf(USER).listTotals(since); // input of the old path
    const daily = await snapshotsOf(USER).listDailyTotals(ids, since);

    expect(daily.length).toBeLessThanOrEqual(ids.length * 32);
    expect(hourly.length).toBeGreaterThan(daily.length * 10);
    expect(lastPerDay(timeline(daily))).toEqual(lastPerDay(timeline(hourly)));

    // Single account: over 30 days the daily points equal the raw points on each day's last point (what the browser's downsampleSeries takes).
    const rawA = await snapshotsOf(USER).listTotalsByAccount(a, since);
    const dailyA = await snapshotsOf(USER).listDailyTotalsByAccount(a, since);
    const asPoints = (rows: { takenAt: number; totalUsd: number }[]) =>
      rows.map((r) => ({ t: r.takenAt, total: r.totalUsd }));
    expect(lastPerDay(asPoints(dailyA))).toEqual(lastPerDay(asPoints(rawA)));
    // Daily points are all real observations (each found among the raw points).
    const rawSet = new Set(rawA.map((r) => `${r.takenAt}:${r.totalUsd}`));
    expect(dailyA.every((r) => rawSet.has(`${r.takenAt}:${r.totalUsd}`))).toBe(true);

    // Single-account long window (SQL caps per bucket): global max / min and first/last points match the raw ones.
    const sampledA = await snapshotsOf(USER).listSampledTotalsByAccount(a);
    const allA = await snapshotsOf(USER).listTotalsByAccount(a);
    const vals = (rows: { totalUsd: number }[]) => rows.map((r) => r.totalUsd);
    expect(Math.max(...vals(sampledA))).toBe(Math.max(...vals(allA)));
    expect(Math.min(...vals(sampledA))).toBe(Math.min(...vals(allA)));
    expect(sampledA[0]).toEqual(allA[0]);
    expect(sampledA[sampledA.length - 1]).toEqual(allA[allA.length - 1]);
    expect(sampledA.length).toBeLessThanOrEqual(400);
  }, 300_000);
});

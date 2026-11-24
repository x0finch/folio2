import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Drizzle } from "../connect";
import { accountDailyTotals, accounts, snapshots } from "../schema";

// Daily rollup of snapshot totals. Long-window charts read this instead of raw snapshots: turning
// thousands of D1 rows into JS objects blew the free tier's 10ms CPU budget.

const DAY_MS = 86_400_000;

/** Same day split as the migration backfill (`CAST(taken_at / 86400000 AS INTEGER) * 86400000`). */
export const utcDay = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;

const TARGET = [accountDailyTotals.accountId, accountDailyTotals.day];

// In UPDATE SET, a bare column name is the old row; `excluded.` is the new value.
const MIN_WINS = sql.raw(
  "excluded.min_usd < min_usd OR (excluded.min_usd = min_usd AND excluded.min_at < min_at)",
);
const MAX_WINS = sql.raw(
  "excluded.max_usd > max_usd OR (excluded.max_usd = max_usd AND excluded.max_at < max_at)",
);

/**
 * Incremental merge for writes that never delete snapshots, so extremes can only grow.
 * Ties: open = earliest, close = latest, min/max = earliest at that value (matches the backfill and
 * `recomputeDailyTotal`). Built with drizzle's insert, not raw `db.run(sql)`: drizzle 0.45 raw
 * queries have no prepared statement and break inside a D1 batch.
 */
export const upsertDailyTotal = (
  db: Drizzle,
  accountId: string,
  takenAt: number,
  totalUsd: number,
) =>
  db
    .insert(accountDailyTotals)
    .values({
      accountId,
      day: utcDay(takenAt),
      openUsd: totalUsd,
      openAt: takenAt,
      minUsd: totalUsd,
      minAt: takenAt,
      maxUsd: totalUsd,
      maxAt: takenAt,
      closeUsd: totalUsd,
      closeAt: takenAt,
    })
    .onConflictDoUpdate({
      target: TARGET,
      set: {
        openUsd: sql`CASE WHEN excluded.open_at < open_at THEN excluded.open_usd ELSE open_usd END`,
        openAt: sql`MIN(open_at, excluded.open_at)`,
        minUsd: sql`CASE WHEN ${MIN_WINS} THEN excluded.min_usd ELSE min_usd END`,
        minAt: sql`CASE WHEN ${MIN_WINS} THEN excluded.min_at ELSE min_at END`,
        maxUsd: sql`CASE WHEN ${MAX_WINS} THEN excluded.max_usd ELSE max_usd END`,
        maxAt: sql`CASE WHEN ${MAX_WINS} THEN excluded.max_at ELSE max_at END`,
        closeUsd: sql`CASE WHEN excluded.close_at >= close_at THEN excluded.close_usd ELSE close_usd END`,
        closeAt: sql`MAX(close_at, excluded.close_at)`,
      },
    });

/**
 * Full-day recompute for writes that delete snapshots (`collapseSameHour`), where a removed row may
 * have been the day's extreme. Must run in the same batch after the snapshot insert: a D1 batch runs
 * in order, so the subqueries see the final rows. The day always has a row, so a NULL here hits NOT
 * NULL and rolls back the batch rather than storing a bad rollup.
 */
export const recomputeDailyTotal = (db: Drizzle, accountId: string, day: number) => {
  const pick = (col: "total_usd" | "taken_at", order: string) => sql`(
    SELECT ${sql.raw(col)} FROM ${snapshots}
    WHERE account_id = ${accountId} AND taken_at >= ${day} AND taken_at < ${day + DAY_MS}
    ORDER BY ${sql.raw(order)} LIMIT 1
  )`;
  const FIRST = "taken_at ASC, rowid ASC";
  const LAST = "taken_at DESC, rowid DESC";
  const LOWEST = "total_usd ASC, taken_at ASC, rowid ASC";
  const HIGHEST = "total_usd DESC, taken_at ASC, rowid ASC";
  return db
    .insert(accountDailyTotals)
    .values({
      accountId,
      day,
      openUsd: pick("total_usd", FIRST),
      openAt: pick("taken_at", FIRST),
      minUsd: pick("total_usd", LOWEST),
      minAt: pick("taken_at", LOWEST),
      maxUsd: pick("total_usd", HIGHEST),
      maxAt: pick("taken_at", HIGHEST),
      closeUsd: pick("total_usd", LAST),
      closeAt: pick("taken_at", LAST),
    })
    .onConflictDoUpdate({
      target: TARGET,
      set: {
        openUsd: sql`excluded.open_usd`,
        openAt: sql`excluded.open_at`,
        minUsd: sql`excluded.min_usd`,
        minAt: sql`excluded.min_at`,
        maxUsd: sql`excluded.max_usd`,
        maxAt: sql`excluded.max_at`,
        closeUsd: sql`excluded.close_usd`,
        closeAt: sql`excluded.close_at`,
      },
    });
};

// `day` lets SQLite range-scan the PK; `close_at` carries the semantics (a partial first day counts
// only if its close is inside the window).
const windowConds = (since?: number) =>
  since == null
    ? []
    : [gte(accountDailyTotals.day, utcDay(since)), gte(accountDailyTotals.closeAt, since)];

/**
 * Portfolio curves use closes only: intraday extremes of different accounts happen at different
 * times, and combining them would invent values that never coexisted.
 */
export async function queryDailyCloses(
  db: Drizzle,
  userId: string,
  accountIds: readonly string[],
  since?: number,
): Promise<{ accountId: string; takenAt: number; totalUsd: number }[]> {
  if (accountIds.length === 0) return [];
  return db
    .select({
      accountId: accountDailyTotals.accountId,
      takenAt: accountDailyTotals.closeAt,
      totalUsd: accountDailyTotals.closeUsd,
    })
    .from(accountDailyTotals)
    .innerJoin(accounts, eq(accounts.id, accountDailyTotals.accountId))
    .where(
      and(
        eq(accounts.userId, userId),
        inArray(accountDailyTotals.accountId, [...accountIds]),
        ...windowConds(since),
      ),
    )
    .orderBy(asc(accountDailyTotals.closeAt));
}

/** Single-account curves can draw intraday extremes as-is. Caller has checked ownership. */
export async function queryDailyPointsByAccount(
  db: Drizzle,
  accountId: string,
  since?: number,
): Promise<{ takenAt: number; totalUsd: number }[]> {
  const rows = await db
    .select({
      openUsd: accountDailyTotals.openUsd,
      openAt: accountDailyTotals.openAt,
      minUsd: accountDailyTotals.minUsd,
      minAt: accountDailyTotals.minAt,
      maxUsd: accountDailyTotals.maxUsd,
      maxAt: accountDailyTotals.maxAt,
      closeUsd: accountDailyTotals.closeUsd,
      closeAt: accountDailyTotals.closeAt,
    })
    .from(accountDailyTotals)
    .where(and(eq(accountDailyTotals.accountId, accountId), ...windowConds(since)))
    .orderBy(asc(accountDailyTotals.day));
  return expandDayPoints(rows, since);
}

interface DayPoints {
  openUsd: number;
  openAt: number;
  minUsd: number;
  minAt: number;
  maxUsd: number;
  maxAt: number;
  closeUsd: number;
  closeAt: number;
}

/** Expands open/low/high/close rows (sorted by time) into up to 4 points each at their real times. */
export function expandDayPoints(
  rows: readonly DayPoints[],
  since?: number,
): { takenAt: number; totalUsd: number }[] {
  const out: { takenAt: number; totalUsd: number }[] = [];
  for (const r of rows) {
    const day: [number, number][] = [
      [r.openAt, r.openUsd],
      [r.minAt, r.minUsd],
      [r.maxAt, r.maxUsd],
      [r.closeAt, r.closeUsd],
    ];
    day.sort((a, b) => a[0] - b[0]);
    let prevT: number | undefined;
    for (const [t, v] of day) {
      // Close is already inside the window via WHERE; earlier points of a partial day are not.
      if (since != null && t < since) continue;
      if (t === prevT) continue; // one snapshot can fill several roles
      prevT = t;
      out.push({ takenAt: t, totalUsd: v });
    }
  }
  return out;
}

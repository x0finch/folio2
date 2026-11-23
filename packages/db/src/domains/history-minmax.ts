import { type SQL, sql } from "drizzle-orm";
import type { Drizzle } from "../connect";
import { accountDailyTotals, accounts, snapshots } from "../schema";
import { expandDayPoints, queryDailyCloses } from "./daily-totals";

// Long-window (1y / all) chart data: capped in SQL, which D1 runs outside the Worker's CPU budget;
// reconstruction and min-max downsampling happen in the browser. Buckets are relative to the
// window, so "1 year" and "all 5 years" return the same number of rows.

/**
 * Per bucket keep the lowest / highest / last moment (plus the first overall) -> at most
 * 3 x buckets + 1 rows per account. Bucket width doesn't matter for extremes: the portfolio's
 * min/max are candidates by construction.
 */
export const HISTORY_SAMPLED_BUCKETS = 66;

/** At most 4 points per bucket (open / low / high / close). */
export const ACCOUNT_SAMPLED_BUCKETS = 100;

const DAY_MS = 86_400_000;

export interface HistoryMinMaxRow {
  takenAt: number;
  totalUsd: number;
}

export interface HistoryMinMaxAccountRow extends HistoryMinMaxRow {
  accountId: string;
}

type RawAccountPoint = { account_id: string; total_usd: number | null };

// Carry-in: each account's last snapshot before `since`, stamped at `since`. Without it an account
// that stopped syncing has no rows in the window, so the curve sits too low and jumps at the live
// endpoint. One indexed point lookup per account, so cost doesn't grow with history. Read from
// snapshots, not daily totals, because `since` can fall mid-day.
export async function queryCarryInTotals(
  db: Drizzle,
  userId: string,
  accountIds: readonly string[] | null,
  since: number,
): Promise<HistoryMinMaxAccountRow[]> {
  if (accountIds != null && accountIds.length === 0) return [];
  const accountFilter =
    accountIds == null
      ? sql``
      : sql`AND a.id IN (${sql.join(
          accountIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  const rows = await db.all<RawAccountPoint>(sql`
    SELECT
      a.id AS account_id,
      (
        SELECT s.total_usd FROM ${snapshots} s
        WHERE s.account_id = a.id AND s.taken_at < ${since}
        ORDER BY s.taken_at DESC, s.rowid DESC
        LIMIT 1
      ) AS total_usd
    FROM ${accounts} a
    WHERE a.user_id = ${userId} ${accountFilter}
  `);
  return rows.flatMap((r) =>
    r.total_usd == null ? [] : [{ accountId: r.account_id, takenAt: since, totalUsd: r.total_usd }],
  );
}

// Same as `windowConds` in daily-totals.ts, in raw SQL.
const windowSql = (since?: number) =>
  since == null
    ? sql``
    : sql` AND t.day >= ${Math.floor(since / DAY_MS) * DAY_MS} AND t.close_at >= ${since}`;

/**
 * Extremum-preserving, capped sampling shared by portfolio and per-token curves.
 *
 * `pointsCtes` must define a CTE `p(account_id, t, v, ord)`: step observations per account; `ord`
 * breaks same-time ties (carry-in 0, real row 1, so the real row wins).
 *
 * Candidates are picked on the portfolio timeline, not per account: account extremes don't coincide,
 * so combining per-account lows would invent values. For each candidate moment every account emits
 * its true value at that moment (stamped to the candidate), so the browser's step reconstruction
 * reproduces the real portfolio value and its global min/max. Archived accounts are ignored when
 * picking; the browser cuts them off by `archivedAt`. The running `tot` sum has float error and is
 * used only to pick moments; emitted values are the originals.
 */
export async function querySampledSteps(
  db: Drizzle,
  pointsCtes: SQL,
  buckets: number,
): Promise<HistoryMinMaxAccountRow[]> {
  const rows = await db.values<[string, number, number]>(sql`
    WITH ${pointsCtes},
    ev AS (
      SELECT account_id, t, v,
        v - COALESCE(LAG(v) OVER (PARTITION BY account_id ORDER BY t, ord), 0) AS dv,
        LEAD(t) OVER (PARTITION BY account_id ORDER BY t, ord) AS next_t
      FROM p
    ),
    tot AS (SELECT t, SUM(SUM(dv)) OVER (ORDER BY t) AS total FROM ev GROUP BY t),
    bounds AS (SELECT MIN(t) AS lo, MAX(t) - MIN(t) + 1 AS span FROM tot),
    ranked AS (
      SELECT tot.t, bounds.lo,
        ROW_NUMBER() OVER w_min AS r_min,
        ROW_NUMBER() OVER w_max AS r_max,
        ROW_NUMBER() OVER w_last AS r_last
      FROM tot, bounds
      WINDOW
        w_min AS (PARTITION BY CAST((tot.t - bounds.lo) * ${buckets} / bounds.span AS INTEGER)
          ORDER BY tot.total, tot.t),
        w_max AS (PARTITION BY CAST((tot.t - bounds.lo) * ${buckets} / bounds.span AS INTEGER)
          ORDER BY tot.total DESC, tot.t),
        w_last AS (PARTITION BY CAST((tot.t - bounds.lo) * ${buckets} / bounds.span AS INTEGER)
          ORDER BY tot.t DESC)
    ),
    marked AS (
      SELECT t,
        MIN(CASE WHEN r_min = 1 OR r_max = 1 OR r_last = 1 OR t = lo THEN t END)
          OVER (ORDER BY t ROWS BETWEEN CURRENT ROW AND UNBOUNDED FOLLOWING) AS k
      FROM ranked
    )
    SELECT ev.account_id, marked.k, ev.v
    FROM ev JOIN marked ON marked.t = ev.t
    WHERE marked.k IS NOT NULL AND (ev.next_t IS NULL OR marked.k < ev.next_t)
    ORDER BY marked.k
  `);
  return rows.map(([accountId, takenAt, totalUsd]) => ({ accountId, takenAt, totalUsd }));
}

/**
 * Daily closes only (see `queryDailyCloses`), plus carry-in and caller-supplied `extra` steps,
 * through `querySampledSteps`. Carry-in takes part in candidate picking so stale accounts stay in.
 */
export async function querySampledTotalsInScope(
  db: Drizzle,
  userId: string,
  accountIds: readonly string[],
  since?: number,
  buckets = HISTORY_SAMPLED_BUCKETS,
  extra: readonly HistoryMinMaxAccountRow[] = [],
): Promise<HistoryMinMaxAccountRow[]> {
  if (accountIds.length === 0 && extra.length === 0) return [];
  const carryIn =
    since == null
      ? sql``
      : sql`
      UNION ALL
      SELECT c.account_id, ${since}, c.v, 0 FROM (
        SELECT scope.id AS account_id, (
          SELECT s.total_usd FROM ${snapshots} s
          WHERE s.account_id = scope.id AND s.taken_at < ${since}
          ORDER BY s.taken_at DESC, s.rowid DESC
          LIMIT 1
        ) AS v
        FROM scope
      ) c WHERE c.v IS NOT NULL`;
  const inScope =
    accountIds.length === 0
      ? sql`0`
      : sql`a.id IN (${sql.join(
          accountIds.map((id) => sql`${id}`),
          sql`, `,
        )})`;
  return querySampledSteps(
    db,
    sql`
    scope AS (
      SELECT a.id FROM ${accounts} a
      WHERE a.user_id = ${userId} AND ${inScope}
    ),
    p AS (
      SELECT t.account_id, t.close_at AS t, t.close_usd AS v, 1 AS ord
      FROM ${accountDailyTotals} t JOIN scope ON scope.id = t.account_id
      WHERE 1 = 1${windowSql(since)}${carryIn}${extraStepsSql(extra)}
    )`,
    buckets,
  );
}

/**
 * Steps from outside the tables (manual accounts, computed by the app) must join the same timeline,
 * or candidates miss their changes and the browser combines values from different moments.
 * One JSON bind parameter per account expanded with `json_each`: D1 allows only 100 bind parameters
 * per statement. Repeated values are dropped, since steps don't change anything there.
 */
function extraStepsSql(extra: readonly HistoryMinMaxAccountRow[]): SQL {
  const byAccount = new Map<string, [number, number][]>();
  for (const r of [...extra].sort((a, b) => a.takenAt - b.takenAt)) {
    const steps = byAccount.get(r.accountId) ?? [];
    if (steps.at(-1)?.[1] !== r.totalUsd) steps.push([r.takenAt, r.totalUsd]);
    byAccount.set(r.accountId, steps);
  }
  return sql.join(
    [...byAccount].map(
      ([accountId, steps]) => sql`
      UNION ALL
      SELECT ${accountId}, CAST(json_extract(j.value, '$[0]') AS INTEGER),
        json_extract(j.value, '$[1]'), 1
      FROM json_each(${JSON.stringify(steps)}) j`,
    ),
  );
}

/**
 * Per-bucket open/low/high/close from daily totals, expanded to at most 4 points each. Extremes are
 * real observations, so the global min/max survive. Caller has checked ownership. When `since` falls
 * mid-day, in-window extremes sort first and earlier points are filtered on expansion.
 */
export async function querySampledPointsByAccount(
  db: Drizzle,
  accountId: string,
  since?: number,
  buckets = ACCOUNT_SAMPLED_BUCKETS,
): Promise<HistoryMinMaxRow[]> {
  const inWindow = (col: string) =>
    since == null ? sql`` : sql`CASE WHEN ${sql.raw(col)} >= ${since} THEN 0 ELSE 1 END, `;
  const rows = await db.values<
    [number, number, number, number, number, number, number, number, number]
  >(
    sql`
    WITH d AS (
      SELECT t.* FROM ${accountDailyTotals} t
      WHERE t.account_id = ${accountId}${windowSql(since)}
    ),
    bounds AS (SELECT MIN(day) AS lo, MAX(day) - MIN(day) + ${DAY_MS} AS span FROM d),
    b AS (
      SELECT d.*, CAST((d.day - bounds.lo) * ${buckets} / bounds.span AS INTEGER) AS bucket
      FROM d, bounds
    )
    SELECT DISTINCT
      FIRST_VALUE(open_at) OVER w_open, FIRST_VALUE(open_usd) OVER w_open,
      FIRST_VALUE(min_at) OVER w_min, FIRST_VALUE(min_usd) OVER w_min,
      FIRST_VALUE(max_at) OVER w_max, FIRST_VALUE(max_usd) OVER w_max,
      FIRST_VALUE(close_at) OVER w_close, FIRST_VALUE(close_usd) OVER w_close,
      bucket
    FROM b
    WINDOW
      w_open AS (PARTITION BY bucket ORDER BY day),
      w_min AS (PARTITION BY bucket ORDER BY ${inWindow("min_at")}min_usd, min_at),
      w_max AS (PARTITION BY bucket ORDER BY ${inWindow("max_at")}max_usd DESC, max_at),
      w_close AS (PARTITION BY bucket ORDER BY day DESC)
    ORDER BY bucket
  `,
  );
  return expandDayPoints(
    rows.map(([openAt, openUsd, minAt, minUsd, maxAt, maxUsd, closeAt, closeUsd]) => ({
      openAt,
      openUsd,
      minAt,
      minUsd,
      maxAt,
      maxUsd,
      closeAt,
      closeUsd,
    })),
    since,
  );
}

/** Carry-in plus one daily close per account. */
export async function queryDailyTotalsInScope(
  db: Drizzle,
  userId: string,
  accountIds: readonly string[],
  since?: number,
): Promise<HistoryMinMaxAccountRow[]> {
  if (accountIds.length === 0) return [];
  const windowRows = await queryDailyCloses(db, userId, accountIds, since);
  // Carry-in must come before windowRows: when both land exactly on `since`, the browser's stable
  // sort lets the later real row win. Reversed, the stale carry-in value would render.
  const carryIn = since != null ? await queryCarryInTotals(db, userId, accountIds, since) : [];
  return [...carryIn, ...windowRows];
}

import { and, asc, eq, gte, sql } from "drizzle-orm";
import type { Drizzle } from "../connect";
import { accounts, snapshots } from "../schema";

/** 长窗 min-max 桶数 —— 与 `apps/web/src/lib/server/history/minmax.ts` 对齐。 */
export const HISTORY_MINMAX_BUCKETS = 40;

export interface HistoryMinMaxRow {
  takenAt: number;
  totalUsd: number;
}

export interface HistoryMinMaxAccountRow extends HistoryMinMaxRow {
  accountId: string;
}

interface MinMaxPoint {
  t: number;
  total: number;
}

function minMaxDownsampleHistory(
  points: readonly MinMaxPoint[],
  buckets = HISTORY_MINMAX_BUCKETS,
): MinMaxPoint[] {
  if (points.length <= 1) return [...points];
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const first = sorted[0];
  const last = sorted[sorted.length - 1];
  if (first == null || last == null) return [...points];
  const tMin = first.t;
  const tMax = last.t;
  if (tMax === tMin) return [first];

  const byBucket = new Map<number, MinMaxPoint[]>();
  for (const p of sorted) {
    const bucket = Math.min(
      Math.floor(((p.t - tMin) * (buckets - 1)) / (tMax - tMin)),
      buckets - 1,
    );
    const arr = byBucket.get(bucket) ?? [];
    arr.push(p);
    byBucket.set(bucket, arr);
  }

  const out: MinMaxPoint[] = [];
  for (const pts of byBucket.values()) {
    const head = pts[0];
    if (head == null) continue;
    let min = head;
    let max = head;
    for (const p of pts) {
      if (p.total < min.total || (p.total === min.total && p.t < min.t)) min = p;
      if (p.total > max.total || (p.total === max.total && p.t < max.t)) max = p;
    }
    if (min.t === max.t && min.total === max.total) out.push(min);
    else {
      out.push(min);
      if (max.t !== min.t || max.total !== min.total) out.push(max);
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/** 阶梯式重建组合净值时间线(与 apps/web buildPortfolioHistory 同语义,无归档截断)。 */
function buildPortfolioTimeline(rows: readonly HistoryMinMaxAccountRow[]): MinMaxPoint[] {
  const sorted = [...rows].sort((a, b) => a.takenAt - b.takenAt);
  const latestByAccount = new Map<string, number>();
  const points: MinMaxPoint[] = [];

  for (let i = 0; i < sorted.length; i++) {
    const row = sorted[i];
    latestByAccount.set(row.accountId, row.totalUsd);
    const isLastAtThisTime =
      i + 1 === sorted.length || sorted[i + 1].takenAt !== row.takenAt;
    if (!isLastAtThisTime) continue;
    let total = 0;
    for (const v of latestByAccount.values()) total += v;
    points.push({ t: row.takenAt, total });
  }
  return points;
}

/** 为保留的组合 min-max 时刻,选出能重建该时刻净值的各账户快照行。 */
function rowsForKeptPortfolioTimes(
  allRows: readonly HistoryMinMaxAccountRow[],
  keptTimes: readonly number[],
): HistoryMinMaxAccountRow[] {
  const sorted = [...allRows].sort((a, b) => a.takenAt - b.takenAt);
  const byAccount = new Map<string, HistoryMinMaxAccountRow[]>();
  for (const r of sorted) {
    const arr = byAccount.get(r.accountId) ?? [];
    arr.push(r);
    byAccount.set(r.accountId, arr);
  }

  const result = new Map<string, HistoryMinMaxAccountRow>();
  for (const T of keptTimes) {
    for (const rows of byAccount.values()) {
      let latest: HistoryMinMaxAccountRow | undefined;
      for (const r of rows) {
        if (r.takenAt <= T) latest = r;
        else break;
      }
      if (latest != null) result.set(`${latest.accountId}:${latest.takenAt}`, latest);
    }
  }
  return [...result.values()].sort((a, b) => a.takenAt - b.takenAt);
}

const minMaxTotalsSql = (buckets: number, scopeSql: ReturnType<typeof sql>, since?: number) => sql`
  WITH filtered AS (
    SELECT s.taken_at AS taken_at, s.total_usd AS total_usd
    FROM ${snapshots} s
    WHERE ${scopeSql}
    ${since != null ? sql`AND s.taken_at >= ${since}` : sql``}
  ),
  bounds AS (
    SELECT MIN(taken_at) AS t_min, MAX(taken_at) AS t_max FROM filtered
  ),
  bucketed AS (
    SELECT
      f.taken_at,
      f.total_usd,
      CASE
        WHEN b.t_max = b.t_min THEN 0
        ELSE MIN(
          CAST((f.taken_at - b.t_min) * (${buckets} - 1) * 1.0 / (b.t_max - b.t_min) AS INTEGER),
          ${buckets} - 1
        )
      END AS bucket
    FROM filtered f, bounds b
    WHERE b.t_max IS NOT NULL
  ),
  ranked AS (
    SELECT
      taken_at,
      total_usd,
      ROW_NUMBER() OVER (
        PARTITION BY bucket ORDER BY total_usd DESC, taken_at ASC
      ) AS max_rn,
      ROW_NUMBER() OVER (
        PARTITION BY bucket ORDER BY total_usd ASC, taken_at ASC
      ) AS min_rn
    FROM bucketed
  )
  SELECT taken_at, total_usd
  FROM ranked
  WHERE max_rn = 1 OR min_rn = 1
  GROUP BY taken_at, total_usd
  ORDER BY taken_at ASC
`;

type RawPoint = { taken_at: number; total_usd: number };

export async function queryMinMaxTotalsByAccount(
  db: Drizzle,
  accountId: string,
  since?: number,
  buckets = HISTORY_MINMAX_BUCKETS,
): Promise<HistoryMinMaxRow[]> {
  const rows = await db.all<RawPoint>(
    minMaxTotalsSql(buckets, sql`s.account_id = ${accountId}`, since),
  );
  return rows.map((r) => ({ takenAt: r.taken_at, totalUsd: r.total_usd }));
}

export async function queryMinMaxTotalsInScope(
  db: Drizzle,
  userId: string,
  accountIds: readonly string[],
  since?: number,
  buckets = HISTORY_MINMAX_BUCKETS,
): Promise<HistoryMinMaxAccountRow[]> {
  if (accountIds.length === 0) return [];
  const accountIn = sql.join(
    accountIds.map((id) => sql`${id}`),
    sql`, `,
  );
  const allRows = await db
    .select({
      accountId: snapshots.accountId,
      takenAt: snapshots.takenAt,
      totalUsd: snapshots.totalUsd,
    })
    .from(snapshots)
    .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
    .where(
      since != null
        ? and(
            eq(accounts.userId, userId),
            sql`${snapshots.accountId} IN (${accountIn})`,
            gte(snapshots.takenAt, since),
          )
        : and(eq(accounts.userId, userId), sql`${snapshots.accountId} IN (${accountIn})`),
    )
    .orderBy(asc(snapshots.takenAt));

  if (allRows.length === 0) return [];

  const portfolioSeries = buildPortfolioTimeline(allRows);
  const kept = minMaxDownsampleHistory(portfolioSeries, buckets);
  if (kept.length === 0) return [];
  return rowsForKeptPortfolioTimes(allRows, kept.map((p) => p.t));
}

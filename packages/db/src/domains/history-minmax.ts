import { sql } from "drizzle-orm";
import type { Drizzle } from "../connect";
import { accounts, snapshots } from "../schema";

/** 长窗 min-max 桶数 —— 与 `apps/web/src/lib/core/history.ts` 的 `TARGET_MAX_POINTS` 对齐。 */
export const HISTORY_MINMAX_BUCKETS = 40;

export interface HistoryMinMaxRow {
  takenAt: number;
  totalUsd: number;
}

export interface HistoryMinMaxAccountRow extends HistoryMinMaxRow {
  accountId: string;
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
type RawAccountPoint = RawPoint & { account_id: string };

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
  const rows = await db.all<RawAccountPoint>(
    sql`
      WITH scoped AS (
        SELECT s.account_id AS account_id, s.taken_at AS taken_at, s.total_usd AS total_usd
        FROM ${snapshots} s
        INNER JOIN ${accounts} a ON a.id = s.account_id
        WHERE a.user_id = ${userId}
          AND s.account_id IN (${accountIn})
        ${since != null ? sql`AND s.taken_at >= ${since}` : sql``}
      ),
      bounds AS (
        SELECT account_id, MIN(taken_at) AS t_min, MAX(taken_at) AS t_max
        FROM scoped
        GROUP BY account_id
      ),
      bucketed AS (
        SELECT
          f.account_id,
          f.taken_at,
          f.total_usd,
          CASE
            WHEN b.t_max = b.t_min THEN 0
            ELSE MIN(
          CAST((f.taken_at - b.t_min) * (${buckets} - 1) * 1.0 / (b.t_max - b.t_min) AS INTEGER),
          ${buckets} - 1
        )
          END AS bucket
        FROM scoped f
        INNER JOIN bounds b ON f.account_id = b.account_id
      ),
      ranked AS (
        SELECT
          account_id,
          taken_at,
          total_usd,
          ROW_NUMBER() OVER (
            PARTITION BY account_id, bucket ORDER BY total_usd DESC, taken_at ASC
          ) AS max_rn,
          ROW_NUMBER() OVER (
            PARTITION BY account_id, bucket ORDER BY total_usd ASC, taken_at ASC
          ) AS min_rn
        FROM bucketed
      )
      SELECT account_id, taken_at, total_usd
      FROM ranked
      WHERE max_rn = 1 OR min_rn = 1
      GROUP BY account_id, taken_at, total_usd
      ORDER BY taken_at ASC
    `,
  );
  return rows.map((r) => ({
    accountId: r.account_id,
    takenAt: r.taken_at,
    totalUsd: r.total_usd,
  }));
}

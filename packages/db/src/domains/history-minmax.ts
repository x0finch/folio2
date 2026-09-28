import { sql } from "drizzle-orm";
import type { Drizzle } from "../connect";
import { accountDailyTotals, accounts, snapshots } from "../schema";
import { expandDayPoints, queryDailyCloses } from "./daily-totals";

// 长窗(1 年 / 全部)曲线的原料 —— **在 SQL 里封顶,不在 Worker 里降采样**(FOL-92)。
//
// FOL-46 / FOL-91 那版是服务端 JS 就地重建组合时间线、min-max 降采样、再按保留时刻把各账户的分解
// 重盖出来:每请求要把窗口内全部日线读进 Worker、排序、逐点求和,那都是 Worker 的 CPU(免费档
// 10ms)。现在服务端只负责**「发多少行」有上界**:SQL 把窗口切成固定个数的时间桶,每账户每桶
// 留一两行真实观测,D1 执行它(不算 Worker CPU);重建与 min-max 降采样在浏览器跑
// (`apps/web/src/lib/core/history.ts` 的 `minMaxDownsampleHistory`),和短窗同一条路。
//
// 桶是**相对窗口**切的:`(day - 最早那天) * 桶数 / 跨度`,于是「1 年」和「全部 5 年」发的行数一样。

/** 组合 / 单币长窗:每账户至多这么多行(每桶一行收盘)。一年 ≈ 1.8 天一桶。 */
export const HISTORY_SAMPLED_BUCKETS = 200;

/** 单账户长窗:至多这么多桶,每桶 ≤ 4 点(开 / 低 / 高 / 收)→ 每账户 ≤ 400 点。 */
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

// **carry-in(窗口左界的起点值)**:每个账户在 `since` 之前的最近一张快照,重盖 takenAt 到 `since`。
//
// 为什么非它不可(review 抓的「曲线偏低 + 末端跳一截」):组合曲线在浏览器按「各账户 ≤ 该时刻
// 最近行之和」逐点重建。窗口按 `taken_at >= since` 裁掉起点前的行之后,一个停了同步的账户
//(冷钱包 / 凭据失效,最近一张早于 `since`)在整个窗口内一行都没有 → 曲线全程不含它,而末点
// 又被实时净值(含它)覆写 → 整条偏低、最右端凭空跳一截。给每个「窗口前有观测」的账户补一行
// 起点值,曲线从窗口起点起就把它算进去。stamped 到 `since` 而非真实时刻,免得在窗口左界之外冒点。
//
// **每账户一次点查**(FOL-91),不是 `ROW_NUMBER() OVER (PARTITION BY account_id …)`:后者要把
// 窗口**之前**的全部快照排一遍 —— 30 天窗口配一年历史就是扫 11 个月,读数随历史线性长。点查走
// `(account_id, taken_at)` 索引倒着取第一条,读数只跟账户数有关(与 `latestWithBalances` 同一招)。
// 值仍取自快照而不是日汇总:窗口起点落在某天中间时,日汇总给不出「起点那一刻之前最近一张」。
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

// 窗口条件(与 `daily-totals.ts` 的 `windowConds` 同义,手写 SQL 版)。
const windowSql = (since?: number) =>
  since == null
    ? sql``
    : sql` AND t.day >= ${Math.floor(since / DAY_MS) * DAY_MS} AND t.close_at >= ${since}`;

/**
 * 组合长窗(1 年 / 全部):carry-in + 每账户**每桶最后一个日收盘**,升序。每账户 ≤ `buckets` 行。
 *
 * 只取收盘的理由同 `queryDailyCloses`(各账户的日内极值不同时发生,拼起来是假值)。
 * 行都是真实观测、时刻不改;浏览器阶梯重建之后再 min-max 降采样。carry-in 排在前面的顺序契约
 * 同 `queryDailyTotalsInScope`。
 */
export async function querySampledTotalsInScope(
  db: Drizzle,
  userId: string,
  accountIds: readonly string[],
  since?: number,
  buckets = HISTORY_SAMPLED_BUCKETS,
): Promise<HistoryMinMaxAccountRow[]> {
  if (accountIds.length === 0) return [];
  const rows = await db.values<[string, number, number]>(sql`
    WITH d AS (
      SELECT t.account_id, t.day, t.close_at, t.close_usd
      FROM ${accountDailyTotals} t
      JOIN ${accounts} a ON a.id = t.account_id
      WHERE a.user_id = ${userId}
        AND t.account_id IN (${sql.join(
          accountIds.map((id) => sql`${id}`),
          sql`, `,
        )})${windowSql(since)}
    ),
    bounds AS (SELECT MIN(day) AS lo, MAX(day) - MIN(day) + ${DAY_MS} AS span FROM d),
    ranked AS (
      SELECT d.account_id, d.close_at, d.close_usd,
        ROW_NUMBER() OVER (
          PARTITION BY d.account_id, CAST((d.day - bounds.lo) * ${buckets} / bounds.span AS INTEGER)
          ORDER BY d.day DESC
        ) AS rn
      FROM d, bounds
    )
    SELECT account_id, close_at, close_usd FROM ranked WHERE rn = 1 ORDER BY close_at
  `);
  const windowRows = rows.map(([accountId, takenAt, totalUsd]) => ({
    accountId,
    takenAt,
    totalUsd,
  }));
  const carryIn = since != null ? await queryCarryInTotals(db, userId, accountIds, since) : [];
  return [...carryIn, ...windowRows];
}

/**
 * 单账户长窗(1 年 / 全部):日汇总按桶合并成「桶内开 / 低 / 高 / 收」,展开成 ≤ 4 点,升序。
 * 每账户 ≤ `buckets × 4` 点。低 / 高取桶内各天的最低 / 最高(真实观测、真实时刻),所以全局极值
 * 原样保留;浏览器再 min-max 降采样到屏幕上那几十个点。调用方已校验归属。
 *
 * 窗口起点落在某天中间时,那天早于起点的开盘 / 极值不算(与 `queryDailyPointsByAccount` 同口径):
 * 极值的排序先把「在窗口内的」排前面,展开时再过滤一遍。
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

/**
 * 组合日线(> 7 天的窗口,FOL-91):carry-in + 每账户每天一行收盘。carry-in 的顺序契约见下面
 * `querySampledTotalsInScope`。
 */
export async function queryDailyTotalsInScope(
  db: Drizzle,
  userId: string,
  accountIds: readonly string[],
  since?: number,
): Promise<HistoryMinMaxAccountRow[]> {
  if (accountIds.length === 0) return [];
  const windowRows = await queryDailyCloses(db, userId, accountIds, since);
  // carry-in:窗口前每账户的起点值(stamped 到 since),让停更账户不从曲线消失。全历史(since 缺省)
  // 不裁窗口,无需补。
  // **carry-in 必须排在 windowRows 之前**(隐性契约):某账户在 since 既有 carry-in(旧值)又有
  // 恰好落在 since 的真实行时,浏览器 `buildPortfolioHistory` 的稳定排序会让后写的真实行覆盖
  // carry-in,真实值胜出。顺序反过来则 since 处会渲染成过期的 carry-in 值。
  const carryIn = since != null ? await queryCarryInTotals(db, userId, accountIds, since) : [];
  return [...carryIn, ...windowRows];
}

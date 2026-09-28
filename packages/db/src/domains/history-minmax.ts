import { sql } from "drizzle-orm";
import type { Drizzle } from "../connect";
import { accounts, snapshots } from "../schema";
import { queryDailyCloses, queryDailyPointsByAccount } from "./daily-totals";

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
  // **端点强制保留**:首桶 / 末桶的极值不一定落在真正的首 / 末点上,而组合曲线是把多条各自
  // 降采样的序列拼起来再逐 takenAt 求和的(见 rowsForKeptPortfolioTimes / manual store)—— 某账户
  // 若从窗口起点起就缺第一个点,别的账户在那个更早的时刻求和时它会被整个漏掉,画出真实历史里
  // 没有的凹口。锚住首末点让每条序列从窗口起点覆盖到末点,合并求和处处不缺人。
  if (!out.some((p) => p.t === first.t)) out.push(first);
  if (!out.some((p) => p.t === last.t)) out.push(last);
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
    const isLastAtThisTime = i + 1 === sorted.length || sorted[i + 1].takenAt !== row.takenAt;
    if (!isLastAtThisTime) continue;
    let total = 0;
    for (const v of latestByAccount.values()) total += v;
    points.push({ t: row.takenAt, total });
  }
  return points;
}

// 为保留的组合 min-max 时刻,发出各账户在该时刻的净值分解,**takenAt 重盖成保留时刻 T**。
//
// **为什么重盖 takenAt(这是修 review 抓的凹口/尖峰的关键)**:浏览器 `buildPortfolioHistory`
// 会在**每一个出现过的 takenAt** 产一个点、按「各账户 ≤ 该 takenAt 的最近行」求和。若直接发各账户
// 的原始行,它们的 takenAt 五花八门,某账户的控制行时刻会成为一个渲染点,而在那个时刻别的账户
// 「真正 ≤ 它的最近行」可能没被任何保留时刻选中 → 求和时那个账户用了更旧的值甚至缺席 → 画出
// 真实历史里没有的凹口/尖峰。把每个保留时刻 T 的各账户行 takenAt 一律重盖成 T,浏览器就**只在
// 保留时刻产点**,且每点求和恰好等于组合序列在 T 的真值(min/max 极值因此原样保住)。
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

  const result: HistoryMinMaxAccountRow[] = [];
  for (const T of keptTimes) {
    for (const [accountId, rows] of byAccount) {
      let latest: HistoryMinMaxAccountRow | undefined;
      for (const r of rows) {
        if (r.takenAt <= T) latest = r;
        else break;
      }
      // 该账户在 T 尚无任何观测(建号晚于 T)→ 这一点它本就不该贡献,跳过。
      if (latest != null) result.push({ accountId, takenAt: T, totalUsd: latest.totalUsd });
    }
  }
  return result.sort((a, b) => a.takenAt - b.takenAt);
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

/**
 * 单账户长窗(1 年 / 全部):日汇总的 open/min/max/close 点 → min-max 降采样到 `buckets` 桶。
 * 输入已是每天 ≤ 4 点(一年 ≤ 1460),降采样在 JS 里做也只是微秒级;不再逐行读快照(FOL-91)。
 */
export async function queryMinMaxTotalsByAccount(
  db: Drizzle,
  accountId: string,
  since?: number,
  buckets = HISTORY_MINMAX_BUCKETS,
): Promise<HistoryMinMaxRow[]> {
  const points = await queryDailyPointsByAccount(db, accountId, since);
  return minMaxDownsampleHistory(
    points.map((p) => ({ t: p.takenAt, total: p.totalUsd })),
    buckets,
  ).map((p) => ({ takenAt: p.t, totalUsd: p.total }));
}

/**
 * 组合日线(> 7 天的窗口,FOL-91):carry-in + 每账户每天一行收盘。carry-in 的顺序契约见下面
 * `queryMinMaxTotalsInScope`。
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
  // 恰好落在 since 的真实行时,`buildPortfolioTimeline` 的稳定排序会让后写的真实行覆盖 carry-in,
  // 真实值胜出。顺序反过来则 since 处会渲染成过期的 carry-in 值。
  const carryIn = since != null ? await queryCarryInTotals(db, userId, accountIds, since) : [];
  return [...carryIn, ...windowRows];
}

/**
 * 组合长窗(1 年 / 全部):日线原料 → 组合净值时间线 → min-max 降采样 → 各账户在保留时刻的分解。
 * 原料从逐小时快照换成日收盘(FOL-91)之后,极值保到「日收盘」这一粒度。
 */
export async function queryMinMaxTotalsInScope(
  db: Drizzle,
  userId: string,
  accountIds: readonly string[],
  since?: number,
  buckets = HISTORY_MINMAX_BUCKETS,
): Promise<HistoryMinMaxAccountRow[]> {
  const allRows = await queryDailyTotalsInScope(db, userId, accountIds, since);
  if (allRows.length === 0) return [];

  const portfolioSeries = buildPortfolioTimeline(allRows);
  const kept = minMaxDownsampleHistory(portfolioSeries, buckets);
  if (kept.length === 0) return [];
  return rowsForKeptPortfolioTimes(
    allRows,
    kept.map((p) => p.t),
  );
}

import { and, asc, eq, gte, inArray, sql } from "drizzle-orm";
import type { Drizzle } from "../connect";
import { accountDailyTotals, accounts, snapshots } from "../schema";

// 快照总额的日汇总(FOL-91)—— 写侧的两条维护语句 + 读侧的两条取数。表的来由见
// `schema/app.ts` 的 `accountDailyTotals`。
//
// **为什么要有这张表**:长窗曲线原来每次请求都把窗口内的快照一行行读出来(一年逐小时 = 每账户
// 8760 行),D1 驱动把行变成 JS 对象这一步就吃掉了大半 CPU,免费档一请求只有 10ms。改读日汇总后
// 行数 ≤ 每账户每天一行,与同步频率脱钩。

const DAY_MS = 86_400_000;

/** 某时刻所在 UTC 日零点(epoch ms)。与迁移回填里 `CAST(taken_at / 86400000 AS INTEGER) * 86400000` 同一种切法。 */
export const utcDay = (t: number): number => Math.floor(t / DAY_MS) * DAY_MS;

const TARGET = [accountDailyTotals.accountId, accountDailyTotals.day];

// 「新值胜出」的判据,各列复用。UPDATE SET 右侧不带表名的列名指**旧行**,`excluded.` 指新值。
const MIN_WINS = sql.raw(
  "excluded.min_usd < min_usd OR (excluded.min_usd = min_usd AND excluded.min_at < min_at)",
);
const MAX_WINS = sql.raw(
  "excluded.max_usd > max_usd OR (excluded.max_usd = max_usd AND excluded.max_at < max_at)",
);

/**
 * 增量维护:把一张新快照并进它那一天的行(无行则建)。只在**不删快照**的写入上用 —— 值只会被
 * 「并进来」,旧的极值不会消失,所以和已有行逐项比一下就够,不必回头读快照。
 *
 * 并列规则与迁移回填、`recomputeDailyTotal` 一致:open 取最早(同刻留先写的),close 取最晚
 * (同刻后写的胜),min/max 取极值、同值取最早。UPDATE SET 里的右侧全部按**旧行**求值(SQLite
 * 的语义),所以各列之间的先后无关。
 *
 * 用 drizzle 的 insert 构造器而不是一整条 `db.run(sql)`:后者进不了 D1 的 batch(drizzle 0.45 的
 * raw 查询没有预编译语句,batch 里一绑参数就炸)。
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
 * 整日重算:从该账户那一天的快照重新求四个点,覆盖那一行。给**会删快照**的写入用
 * (`collapseSameHour`):被折叠掉的那张可能正是当天的极值 / 开盘,增量比较不会让它「退出」。
 *
 * **必须排在同一个 batch 里、插新快照之后**(CLAUDE.md 的 D1 一节:batch 是按序执行的一个事务,
 * 后面的语句读得到前面写的行)—— 每列一个标量子查询,读到的正是「删完、插完」的那一天,不必在
 * JS 里先读后写。子查询走 `(account_id, taken_at)` 索引上一天的区间:按小时折叠后 ≤ 24 行;
 * 首末两列取到第一条即停,极值那四列各扫一遍区间 —— 每次写约百行读,与历史长度无关。
 *
 * 那一天恒有至少一张(刚插的那张),子查询不会是 NULL;真是 NULL 就撞 NOT NULL、整批回滚 —— 宁可
 * 这次同步失败,也不落一行坏汇总。
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

// 窗口条件:`day` 那一侧让 SQLite 在 (account_id, day) 主键上走区间;`close_at` 那一侧才是语义
// (窗口起点落在某天中间时,那天的收盘在窗口内才算)。
const windowConds = (since?: number) =>
  since == null
    ? []
    : [gte(accountDailyTotals.day, utcDay(since)), gte(accountDailyTotals.closeAt, since)];

/**
 * 组合曲线的日线原料:本用户、指定账户、窗口内每账户每天**一行收盘**(stamped 到 close_at),升序。
 *
 * **组合只取收盘,不取日内极值** —— 各账户的日内高低点发生在不同时刻,拼进阶梯重建会凑出
 * 「A 的最高 + B 的最低」这种从没同时出现过的组合值。收盘则每个都是真实观测;同步一轮各账户
 * 同一钟点落快照,当天最后那个点就是组合当天的真实收盘。
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

/**
 * 单账户曲线的日线原料:窗口内每天的 open / min / max / close 四个点(各在其真实时刻,同刻去重),
 * 升序。单账户没有「跨账户拼凑」的问题,日内极值原样画出来就是真的。调用方已校验归属。
 */
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
      // 窗口起点落在当天中间时,早于它的开盘 / 极值不出窗口(收盘已由 WHERE 保证在窗口内)。
      if (since != null && t < since) continue;
      if (t === prevT) continue; // 同一张快照兼任几个角色(一天只有一张时四个全是它)
      prevT = t;
      out.push({ takenAt: t, totalUsd: v });
    }
  }
  return out;
}

import { type SQL, sql } from "drizzle-orm";
import type { Drizzle } from "../connect";
import { accountDailyTotals, accounts, snapshots } from "../schema";
import { expandDayPoints, queryDailyCloses } from "./daily-totals";

// 长窗(1 年 / 全部)曲线的原料 —— **在 SQL 里封顶,不在 Worker 里降采样**(FOL-92)。
//
// FOL-46 / FOL-91 那版是服务端 JS 就地重建组合时间线、min-max 降采样、再按保留时刻把各账户的分解
// 重盖出来:每请求要把窗口内全部日线读进 Worker、排序、逐点求和,那都是 Worker 的 CPU(免费档
// 10ms)。现在服务端只负责**「发多少行」有上界、且极值在里面**:SQL 把窗口切成固定个数的时间桶,
// 按桶挑出该留的时刻(组合 / 单币见 `querySampledSteps`,单账户见 `querySampledPointsByAccount`),
// D1 执行它(不算 Worker CPU);重建与 min-max 降采样在浏览器跑
// (`apps/web/src/lib/core/history.ts` 的 `minMaxDownsampleHistory`),和短窗同一条路。
//
// 桶是**相对窗口**切的:`(day - 最早那天) * 桶数 / 跨度`,于是「1 年」和「全部 5 年」发的行数一样。

/**
 * 组合 / 单币长窗:组合时间线切成这么多桶,每桶留**最低 / 最高 / 最后**三个时刻(外加首个时刻)
 * → 至多 `3 × 桶数 + 1` 个候选时刻;每账户每个候选时刻至多一行 → **每账户 ≤ 199 行**
 * (值不变的时刻不重复发,实际更少;与上一版「每桶一行 × 200 桶」同一量级的载荷)。
 * 一年 ≈ 5.5 天一桶,5 年 ≈ 28 天一桶 —— 桶宽不影响极值,组合的最低 / 最高点按定义就在候选里。浏览器最后画的是 40 桶 min-max,远粗于这里。
 */
export const HISTORY_SAMPLED_BUCKETS = 66;

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
 * 长窗的「保极值 + 封顶」采样(review #2),组合与单币共用。
 *
 * 入参 `pointsCtes` 必须定义一个名为 `p` 的 CTE(可以前面再带别的 CTE):
 * `p(account_id, t, v, ord)` —— 每账户的阶梯观测(某时刻起该账户值为 v,直到它下一行);
 * `ord` 只在同账户同时刻有两行时定先后(carry-in 给 0、真实行给 1,真实行胜出)。
 *
 * **为什么不能「每账户每桶留几行」**:组合值 = Σ 各账户在该时刻的值,而各账户的极值不同时发生。
 *   · 每账户每桶只留收盘(上一版)→ 一次落在桶中间的闪崩整个被丢掉,浏览器 min-max 无从保起。
 *   · 每账户每桶留自己的低 / 高再拼起来 → 拼出来的是「A 的低 + B 的低」,一个从没存在过的组合值。
 * 所以候选时刻在**组合时间线**上挑,每个候选时刻给出**每个账户在那一刻的真值**:
 *   1. `ev`:每账户逐行的增量 `dv`(本行减上一行);`tot`:按时刻求和再累加 = 每个事件时刻的
 *      组合值(同一套阶梯语义,浏览器 `buildPortfolioHistory` 就是这么算的)。
 *   2. 组合时间线按相对窗口切 `buckets` 桶,每桶取最低 / 最高 / 最后那个时刻 + 全局首个时刻 = 候选 K。
 *   3. 每个账户行 r(时刻 t,下一行时刻 next_t)若有候选 k 落在 [t, next_t),它就是该账户在 k 的值 →
 *      发一行 `(account, k, v)`,只发最早那个 k(后面的候选浏览器阶梯沿用即可)。
 * 于是发出的行**都落在候选时刻上**、每个候选时刻各账户的最近行都在里面 → 浏览器阶梯重建出的每个
 * 点都等于真实组合值(日收盘口径),组合的全局最低 / 最高原样在里面。时刻被重盖到 k(不再是该账户
 * 自己的观测时刻),值仍是真实观测 —— 与 FOL-91 那版在 Worker 里做的「重盖到保留时刻」同一招,
 * 只是挪进了 SQL(D1 执行,不算 Worker CPU)。
 *
 * **不看归档**(挑候选时):归档账户之后不再有新行,它在归档后贡献的是一个常数,只影响「归档那一刻
 * 所在的桶」里挑哪一天;值由浏览器按 `archivedAt` 截断,仍然准确。
 *
 * 界:每账户 ≤ `3 × buckets + 1` 行。`tot` 求和累加会带浮点误差,只用来**挑时刻**,发出去的值是原值。
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
 * 组合长窗(1 年 / 全部):日收盘 + carry-in(+ 调用方给的表外阶梯 `extra`,手记账户用)过
 * `querySampledSteps`,升序。每账户 ≤ `3 × buckets + 1` 行。
 *
 * 只用日收盘的理由同 `queryDailyCloses`(各账户的日内极值不同时发生,拼起来是假值)。
 * carry-in(窗口前的起点值,见 `queryCarryInTotals`)在同一条语句里补,stamped 到 `since`,
 * 并参与挑候选 —— 否则停更账户在整个窗口里不在组合值里。
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
 * **表外的阶梯观测**(review R2-#5):手记账户的曲线不在快照 / 日汇总里,由 app 从账本算出来
 * (`loadManualHistoryRows`)。它们必须**进同一条组合时间线**:挑候选时刻要看得见它们的变化,每个
 * 候选时刻也要带上它们在那一刻的值 —— 否则浏览器在一个手记时刻上会把 synced 账户最多一桶之前的
 * 值和手记当下的值加在一起,拼出一个从没存在过的组合值,组合的极值也不保证还在。
 *
 * 形状:每个账户一个绑定参数,装 `[[t, v], …]` 的 JSON,`json_each` 展开(D1 一条语句最多 100 个绑定
 * 参数,逐行绑定放不下一年的日线)。值不变的相邻行先去掉 —— 阶梯语义下它们不改变任何时刻的值。
 * 这些行由调用方给、原样按候选时刻重盖后发回,不读任何表,所以不涉及归属。
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
 * 组合日线(> 7 天的窗口,FOL-91):carry-in + 每账户每天一行收盘。
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

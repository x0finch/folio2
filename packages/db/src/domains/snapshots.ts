import { type BalanceKind, Note } from "@folio/connectors-basic";
import {
  and,
  asc,
  count,
  desc,
  eq,
  getTableColumns,
  gte,
  inArray,
  isNotNull,
  lt,
  lte,
  max,
  sql,
} from "drizzle-orm";
import { Effect } from "effect";
import { DbClient } from "../client";
import type { Drizzle } from "../connect";
import { CurrentUser } from "../current-user";
import type { NotFound } from "../errors";
import { accounts, snapshotBalances, snapshots } from "../schema";
import type { Snapshot, SnapshotBalance } from "../schema/types";
import {
  HISTORY_MINMAX_BUCKETS,
  queryCarryInTotals,
  queryMinMaxTotalsByAccount,
  queryMinMaxTotalsInScope,
} from "./history-minmax";
import { assertAccountOwned } from "./ownership";

// 快照 —— 一次同步落下的余额切片,以及总额 / 历史 / 分页那几条读路。
//
// **服务的方法签名里没有 userId**(ADR 0037):由 `SnapshotStore.Default(userId)` 在装配那一刻吃掉。

// D1 每条 SQL 最多 100 个绑定参数;snapshot_balances 现在每行 10 列 → 每块 8 行(80 个,限内)。
// **加列必须回来改这个数**:列数 × 块行数不得超 100,否则 "too many SQL variables",只在持仓多的账户上炸。
const BALANCE_INSERT_CHUNK = 8;

// 折叠的桶宽(#461)。**必须与读侧最细的桶一致** —— `apps/web/src/lib/history.ts` 的
// `BUCKET_LADDER[0]` 就是它,而折叠的全部理由就是「读侧本来就只画每个钟点的最后一个点」。
// 按**绝对钟点**切(`floor(t / HOUR)`),和读侧同一种切法,不是「距上一张一小时内」。
const HOUR_MS = 3_600_000;

export interface SnapshotBalanceInput {
  amount: number;
  usdValue: number;
  kind: BalanceKind;
  // 这笔持仓所在的链 ∪ 场馆,provider 直接报(ADR 0021 / #193)。可选:同步恒会给,
  // 但导入旧版本文件(v2 没有这个字段)时缺席 —— 与列本身可空同一个理由。
  platform?: string;
  selfPrice?: number; // provider 自带单价(估值原料,Phase 3);落 snapshot_balances.self_price
  // 认定冻进快照(ADR 0021 / #200):写快照前经 mint 换出的代币行 id。显示名(symbol)从此只住
  // Token 那一行,读端按它取 —— 快照不再存 symbol / token_ref(#243)。
  // 可选:expand 期旧路径不给(列可空),导入旧版本文件也没有。编排在 app —— db 只负责落列。
  tokenId?: string;
  meta?: Record<string, unknown>;
  note?: Note; // balance 级展示 note(note 重设计,单个 Note);落 snapshot_balances.note(JSON)
}

export interface WriteSnapshotInput {
  takenAt: number;
  totalUsd: number;
  note?: Note[]; // account 级展示 note(note 重设计,Note[] 整钱包);落 snapshots.note(JSON)
  balances: SnapshotBalanceInput[];
}

// 读模型的余额行:原始 SnapshotBalance,note 列已 safeParse 成单个 Note(空/损坏 → 省略)。
export type SnapshotBalanceView = Omit<SnapshotBalance, "note"> & { note?: Note };

export interface SnapshotWithBalances {
  snapshot: Snapshot;
  note?: Note[]; // account 级展示 note,已从 snapshot.note(JSON)safeParse 成 Note[](空/损坏 → 省略)
  balances: SnapshotBalanceView[];
}

// 快照余额行的 note 列(JSON 字符串)→ 单个 Note。损坏/为空 → undefined(无 note 的持仓)。
function parseBalanceNote(raw: string | null): Note | undefined {
  if (!raw) return undefined;
  try {
    const r = Note.safeParse(JSON.parse(raw));
    return r.success ? r.data : undefined;
  } catch {
    return undefined;
  }
}

// 账户快照的 note 列(JSON 字符串)→ account 级 Note[]。损坏/为空 → undefined。
function parseAccountNote(raw: string | null): Note[] | undefined {
  if (!raw) return undefined;
  try {
    const r = Note.array().safeParse(JSON.parse(raw));
    return r.success && r.data.length > 0 ? r.data : undefined;
  } catch {
    return undefined;
  }
}

export interface SnapshotTotal {
  accountId: string;
  takenAt: number;
  totalUsd: number;
}

export interface SnapshotBalanceHistoryRow {
  accountId: string;
  takenAt: number;
  amount: number;
  usdValue: number;
  kind: BalanceKind;
  tokenId: string | null; // 归并身份(写快照时 mint 定死);单币历史按它归属(#201)
  platform: string | null;
  metaJson: string | null;
}

export const makeSnapshotStore = Effect.gen(function* () {
  const client = yield* DbClient;
  const userId = yield* CurrentUser;

  /**
   * 每账户「窗口内最新」的快照 + 其余额;`upTo`/`floor` 缺省 = 不设那一侧的界。
   *   · `upTo == null && floor == null` → 每账户最新那张(`latest()`)。
   *   · `upTo` 设定 → 每账户 `takenAt ≤ upTo` 里最新那张;再叠 `floor` → 还要 `takenAt ≥ floor`
   *     (24h 盈亏「起点」那一端,ADR 0050:窗口 `[floor, upTo]`,窗口内没有快照的账户不出现)。
   * 常数次查询(与账户数无关):① 每账户命中快照整行 ② 这些快照的全部余额,再 JS 分组。
   * 没有命中快照的账户自然不出现 —— 「不出现」正是读端「这个账户没有那一刻的观测」的判据。
   */
  const latestWithBalances = (bounds?: {
    upTo?: number;
    floor?: number;
  }): Effect.Effect<SnapshotWithBalances[]> =>
    Effect.gen(function* () {
      // ① 取每账户窗口内最新快照整行(1 查询)。
      // 子查询:该用户每个账户在 `[floor, upTo]` 内的最新 takenAt(经 snapshots ⨝ accounts 用 userId 限定)。
      const latestSnapshots = yield* client.query((db) => {
        const conds = [eq(accounts.userId, userId)];
        if (bounds?.upTo != null) conds.push(lte(snapshots.takenAt, bounds.upTo));
        if (bounds?.floor != null) conds.push(gte(snapshots.takenAt, bounds.floor));
        const latestPerAccount = db
          .select({
            accountId: snapshots.accountId,
            maxTakenAt: max(snapshots.takenAt).as("max_taken_at"),
          })
          .from(snapshots)
          .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
          .where(and(...conds))
          .groupBy(snapshots.accountId)
          .as("latest_per_account");
        return db
          .select(getTableColumns(snapshots))
          .from(snapshots)
          .innerJoin(
            latestPerAccount,
            and(
              eq(snapshots.accountId, latestPerAccount.accountId),
              eq(snapshots.takenAt, latestPerAccount.maxTakenAt),
            ),
          );
      });

      // 同毫秒并列保护:每账户保留一条(id 最大者)。
      const byAccount = new Map<string, Snapshot>();
      for (const s of latestSnapshots) {
        const cur = byAccount.get(s.accountId);
        if (!cur || s.id > cur.id) byAccount.set(s.accountId, s);
      }
      const snaps = [...byAccount.values()];
      if (snaps.length === 0) return [];

      // ② 取这些快照的全部余额(1 查询)。
      const balanceRows = yield* client.query((db) =>
        db
          .select()
          .from(snapshotBalances)
          .where(
            inArray(
              snapshotBalances.snapshotId,
              snaps.map((s) => s.id),
            ),
          ),
      );

      // JS 按 snapshotId 分组;每行的 note 列(JSON)safeParse 成单个 Note(balance 级)。
      const bySnapshot = new Map<string, SnapshotBalanceView[]>();
      for (const b of balanceRows) {
        const { note, ...rest } = b;
        const view: SnapshotBalanceView = { ...rest, note: parseBalanceNote(note) };
        const arr = bySnapshot.get(b.snapshotId);
        if (arr) arr.push(view);
        else bySnapshot.set(b.snapshotId, [view]);
      }
      return snaps.map((snapshot) => ({
        snapshot,
        // account 级 note(Note[])从 snapshot.note(JSON)safeParse。
        note: parseAccountNote(snapshot.note),
        balances: bySnapshot.get(snapshot.id) ?? [],
      }));
    });

  return {
    /**
     * 一次原子写 snapshot + balances(D1 用 db.batch,无交互式事务)。返回 snapshotId。
     *
     * `collapseSameHour`(#461):同账户、同一个**钟点**里已经有快照 → 连它的余额行一起删掉再写,
     * 一个钟点只留最后一份。默认 **false = 照旧追加**。
     *
     * **为什么要有这件事**:写入侧对同步频率没有任何限制(手点 20 次就落 20 份 + 20 × 持币数 行),
     * 而读侧的 `downsampleSeries` 最细的桶就是一小时、每桶只取最后一个点 —— 同钟点内那些份在趋势图上
     * **一份都看不到**。存了却画不出来。这条给「目前没有上限的事」加上上限:每账户每小时至多一份。
     * 自动同步已经是每小时一次(#446),对它是空操作。
     *
     * **为什么默认关**:这个开关的判据是「这次写的是**此刻的状态**(可以被同钟点更晚的一次取代),
     * 还是**一份历史事实**(必须原样留着)」。同步是前者;**导入是后者** —— 而导入
     * (`TransferStore.importSnapshot`)正是转手调的这个方法。默认开就意味着「恢复自己的备份」会
     * 静默丢掉同一小时里的历史快照。两种默认里,忘了开只是少省点空间,忘了关是丢数据。
     *
     * **代价接近零**:24h 盈亏(ADR 0050)只取两个端点(最新一张 + `asOf` 起点那一张),
     * 同钟点折叠最多让起点挪动不到一小时 —— 分辨充提与行情绰绰有余。所以桶宽只到一小时。
     */
    write: (
      accountId: string,
      input: WriteSnapshotInput,
      opts?: { collapseSameHour?: boolean },
    ): Effect.Effect<string, NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        const snapshotId = crypto.randomUUID();
        const balanceRows = input.balances.map((b) => ({
          id: crypto.randomUUID(),
          snapshotId,
          amount: b.amount,
          usdValue: b.usdValue,
          kind: b.kind,
          selfPrice: b.selfPrice ?? null,
          platform: b.platform ?? null,
          // token_id 现在 NOT NULL(#243)。输入类型仍留可空,好让 v2 导入(无身份可落)能编译 ——
          // 它写空值时**有意**撞约束、导入失败(#204 的 v3 导入携带身份后恢复)。sync 经 mint、手记合成
          // 都恒给值,只有那一条活口会 null。cast 把强制点从编译期挪到 DB 约束(唯一真事实源)。
          tokenId: (b.tokenId ?? null) as string,
          metaJson: b.meta ? JSON.stringify(b.meta) : null,
          // balance 级 note(单个 Note)→ JSON;无则 null。
          note: b.note ? JSON.stringify(b.note) : null,
        }));
        // 整批原子写(D1 无交互式事务):snapshot + 各分块余额。空余额则只写 snapshot。
        // D1 限制每条 SQL 最多 100 个绑定参数 → 分块,每块 ≤ BALANCE_INSERT_CHUNK 行(见其定义)。
        // 一次性大 INSERT 会触发 "too many SQL variables"(地址持仓多时,如链上钱包几十上百条)。
        const hourStart = Math.floor(input.takenAt / HOUR_MS) * HOUR_MS;
        yield* client.batch((db) => {
          const balanceInserts = [];
          for (let i = 0; i < balanceRows.length; i += BALANCE_INSERT_CHUNK) {
            balanceInserts.push(
              db.insert(snapshotBalances).values(balanceRows.slice(i, i + BALANCE_INSERT_CHUNK)),
            );
          }
          return [
            // 折叠(#461):删旧那份**排在插新那份之前**,而且必须在同一个 batch 里。
            //   · 顺序反了 → 把刚插进去的那张一起删掉(它的 takenAt 也落在这个钟点里)。
            //   · 拆成两次调用 → 中间失败就留下「删了没写」的空洞,那个钟点整段没了。
            // batch 是一个按序执行的事务(CLAUDE.md 的 D1 一节),所以这一删一插是原子的;并发的
            // 两次同步也因此各自是完整事务,后到的那次删掉先到的,不会两份并存。
            // 余额行由 `snapshot_balances.snapshot_id` 的 ON DELETE CASCADE 一起走(D1 运行时真的执行)。
            ...(opts?.collapseSameHour
              ? [
                  db
                    .delete(snapshots)
                    .where(
                      and(
                        eq(snapshots.accountId, accountId),
                        gte(snapshots.takenAt, hourStart),
                        lt(snapshots.takenAt, hourStart + HOUR_MS),
                      ),
                    ),
                ]
              : []),
            db.insert(snapshots).values({
              id: snapshotId,
              accountId,
              takenAt: input.takenAt,
              totalUsd: input.totalUsd,
              // account 级 note(Note[] 整钱包)→ JSON;空则 null。
              note: input.note && input.note.length > 0 ? JSON.stringify(input.note) : null,
            }),
            ...balanceInserts,
          ];
        });
        return snapshotId;
      }),

    listByAccount: (accountId: string): Effect.Effect<Snapshot[], NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        return yield* client.query((db) =>
          db
            .select()
            .from(snapshots)
            .where(eq(snapshots.accountId, accountId))
            .orderBy(desc(snapshots.takenAt)),
        );
      }),

    /**
     * 单账户曲线的数据源:该账户快照的 (takenAt, totalUsd),按 takenAt 升序,`since` 裁窗口。
     *
     * **与 `listByAccount` 分开是有理由的**:那个是 `select()` 全列(含 `note` / `meta_json`
     * 这些整块 JSON)、也没有窗口,给的是「一张完整的快照」;曲线只要两个数,而这份要出门
     * (读接口把点原样发给浏览器算,FOL-38)。窗口是 WHERE,不是计算 —— 发多少行由它定死,
     * 免得一个同步了一年的账户把整段历史都塞进一次响应。
     */
    listTotalsByAccount: (
      accountId: string,
      since?: number,
    ): Effect.Effect<{ takenAt: number; totalUsd: number }[], NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        return yield* client.query((db) =>
          db
            .select({ takenAt: snapshots.takenAt, totalUsd: snapshots.totalUsd })
            .from(snapshots)
            .where(
              since == null
                ? eq(snapshots.accountId, accountId)
                : and(eq(snapshots.accountId, accountId), gte(snapshots.takenAt, since)),
            )
            .orderBy(asc(snapshots.takenAt)),
        );
      }),

    listTotalsByAccountMinMax: (
      accountId: string,
      since?: number,
      buckets = HISTORY_MINMAX_BUCKETS,
    ): Effect.Effect<{ takenAt: number; totalUsd: number }[], NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        return yield* client.query((db) =>
          queryMinMaxTotalsByAccount(db, accountId, since, buckets),
        );
      }),

    listTotalsMinMax: (
      accountIds: readonly string[],
      since?: number,
      buckets = HISTORY_MINMAX_BUCKETS,
    ): Effect.Effect<SnapshotTotal[]> =>
      client.query((db) => queryMinMaxTotalsInScope(db, userId, accountIds, since, buckets)),

    /** 历史曲线数据源:全部快照的 (accountId, takenAt, totalUsd),按 takenAt 升序。 */
    // 只取这三列、不取 balances(比 `latest` 轻);组合净值时间序列在纯函数里
    // 阶梯式重建(见 apps/web buildPortfolioHistory)。
    listTotals: (since?: number): Effect.Effect<SnapshotTotal[]> =>
      client.query(async (db) => {
        const windowRows = await db
          .select({
            accountId: snapshots.accountId,
            takenAt: snapshots.takenAt,
            totalUsd: snapshots.totalUsd,
          })
          .from(snapshots)
          .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
          .where(
            since == null
              ? eq(accounts.userId, userId)
              : and(eq(accounts.userId, userId), gte(snapshots.takenAt, since)),
          )
          .orderBy(asc(snapshots.takenAt));
        // 裁了窗口(短窗曲线)就补 carry-in:窗口前每账户的起点值(stamped 到 since),否则停更
        // 账户在窗口内一行都没有 → 曲线偏低、末端跳变(见 queryCarryInTotals)。全历史不裁,不补。
        // **carry-in 必须排在 windowRows 之前**:某账户在 since 既有 carry-in 又有恰好落在 since 的
        // 真实行时,浏览器 buildPortfolioHistory 的稳定排序让后写的真实行覆盖 carry-in,真实值胜出。
        if (since == null) return windowRows;
        const carryIn = await queryCarryInTotals(db, userId, null, since);
        return [...carryIn, ...windowRows];
      }),

    /** 全历史余额(跨所有快照):单币价值历史用。可选 since(epoch ms)裁窗口。 */
    // app 侧按代币身份归属 + 阶梯式重建(见 apps/web buildTokenValueHistory)。每行带其快照的
    // accountId/takenAt + 该余额的冻结口径列。snapshot_balances 仅按 snapshotId 建索引 → 跨快照全扫;
    // 自托管单用户量级可接受(见 #121 备注),量大再议加 (account_id, taken_at) 复合索引。
    listBalanceHistory: (since?: number): Effect.Effect<SnapshotBalanceHistoryRow[]> =>
      client.query((db) =>
        db
          .select({
            accountId: snapshots.accountId,
            takenAt: snapshots.takenAt,
            amount: snapshotBalances.amount,
            usdValue: snapshotBalances.usdValue,
            kind: snapshotBalances.kind,
            tokenId: snapshotBalances.tokenId,
            platform: snapshotBalances.platform,
            metaJson: snapshotBalances.metaJson,
          })
          .from(snapshotBalances)
          .innerJoin(snapshots, eq(snapshots.id, snapshotBalances.snapshotId))
          .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
          .where(
            since != null
              ? and(eq(accounts.userId, userId), gte(snapshots.takenAt, since))
              : eq(accounts.userId, userId),
          )
          .orderBy(asc(snapshots.takenAt)),
      ),

    /**
     * 单币价值历史的原料(FOL-50):只取某一 token_id 在窗口内的余额行,升序。
     * 窗口是 WHERE,不是计算 —— 浏览器拿原样行喂 buildTokenValueHistory。
     */
    listBalanceHistoryForToken: (
      tokenId: string,
      since?: number,
    ): Effect.Effect<SnapshotBalanceHistoryRow[]> =>
      client.query((db) =>
        db
          .select({
            accountId: snapshots.accountId,
            takenAt: snapshots.takenAt,
            amount: snapshotBalances.amount,
            usdValue: snapshotBalances.usdValue,
            kind: snapshotBalances.kind,
            tokenId: snapshotBalances.tokenId,
            platform: snapshotBalances.platform,
            metaJson: snapshotBalances.metaJson,
          })
          .from(snapshotBalances)
          .innerJoin(snapshots, eq(snapshots.id, snapshotBalances.snapshotId))
          .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
          .where(
            since != null
              ? and(
                  eq(accounts.userId, userId),
                  eq(snapshotBalances.tokenId, tokenId),
                  gte(snapshots.takenAt, since),
                )
              : and(eq(accounts.userId, userId), eq(snapshotBalances.tokenId, tokenId)),
          )
          .orderBy(asc(snapshots.takenAt)),
      ),

    /** 每个账户的最新快照 + 其余额(总览数据源)。 */
    latest: (): Effect.Effect<SnapshotWithBalances[]> => latestWithBalances(),

    /**
     * 每个账户在 `[floor, t]` 窗口内**最新**的一张快照 + 其余额 —— 24h 盈亏「起点」那一端的
     * 数据源(ADR 0050:起点 = 24 小时前那一刻或更早的最近观测,但不早于 `floor`)。
     *
     * **是 ≤ 不是 ≥**:往后找最近一张等于拿几小时前的数冒充 24 小时前,窗口被悄悄截短。
     * **`floor` 是 7 天断线线**:窗口内一张都没有的账户不出现 —— 读端据此判「这个账户起点空
     * →涨跌当 0,不拿极旧的值虚增」。中断几天但仍在窗口内 → 顺延到窗口内最近那张。
     */
    asOf: (t: number, floor: number): Effect.Effect<SnapshotWithBalances[]> =>
      latestWithBalances({ upTo: t, floor }),

    /** 导出用:分页取全部快照(按 takenAt,id 稳定排序)。 */
    // 配合 `balancesFor` 一页页流式读出,内存恒定;每页配 inArray(≤ 页大小)取余额,
    // 避开 D1 100 绑定参数上限。
    listPage: (limit: number, offset: number): Effect.Effect<Snapshot[]> =>
      client.query((db) =>
        db
          .select(getTableColumns(snapshots))
          .from(snapshots)
          .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
          .where(eq(accounts.userId, userId))
          .orderBy(asc(snapshots.takenAt), asc(snapshots.id))
          .limit(limit)
          .offset(offset),
      ),

    /**
     * 取指定快照的余额。调用方须保证 ids 数量 ≤ 分页大小(< D1 100 绑定参数上限)。
     *
     * **它不收 userId**(全服务只有这一个这样)。仍然放进 per-user 服务是有判据的(ADR 0037):
     * 它只在 per-user 上下文里被调(上一步的 `listPage` 已经按 userId 限定过),装进来比今天
     * 靠调用方口头保证更清楚。
     */
    // 导出(#204)按 token_id 走(v3),不再需要 symbol,故这里不再 join tokens。
    balancesFor: (snapshotIds: string[]): Effect.Effect<SnapshotBalance[]> =>
      snapshotIds.length === 0
        ? Effect.succeed([])
        : client.query((db) =>
            db
              .select()
              .from(snapshotBalances)
              .where(inArray(snapshotBalances.snapshotId, snapshotIds)),
          ),

    /**
     * 清掉过旧快照上的展示 note(#456),返回清掉的行数。`olderThan` 是 epoch ms 的下界。
     *
     * **为什么只清 note、不清 `meta_json`**:词汇表那条分野就是判据 —— note 是「仅供展示、无共享
     * 逻辑读」,而 meta 是「共享逻辑会结构化读」的 typed 层(24h 盈亏从它取 DeFi 协议名、
     * `balance-kind` 从老 perp 行取 role 判 kind)。清 meta 会让历史算错,不只是少显示点东西。
     *
     * **每账户最新那张永不清**:界面读的就是它(`latest()`)。窗口通常盖不到最新快照,但停了同步的
     * 账户(已归档 / 凭据失效)会整个落在窗口外 —— 那时按时间清会把它唯一那份 note 也清掉,抽屉里
     * 就空了。判据写成「存在更新的同账户快照」,不是「取每账户 max(taken_at) 再排除」。
     */
    pruneNotes: (olderThan: number): Effect.Effect<{ snapshots: number; balances: number }> =>
      Effect.gen(function* () {
        // 「不是本账户最新那张」= 存在同账户、更晚的快照。写成 EXISTS 而不是「先取每账户
        // max(taken_at) 再排除」:后者要么多一趟查询,要么在 UPDATE 里嵌一个 GROUP BY 子查询,
        // 而这条 EXISTS 直接走 (account_id, taken_at) 那条复合索引。
        const notLatest = sql`exists (
            select 1 from ${snapshots} newer
            where newer.account_id = ${snapshots.accountId}
              and newer.taken_at > ${snapshots.takenAt}
          )`;
        // 待清的快照:本用户的、够旧的、且不是各账户最新那张。
        const stale = (db: Drizzle) =>
          db
            .select({ id: snapshots.id })
            .from(snapshots)
            .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
            .where(and(eq(accounts.userId, userId), lt(snapshots.takenAt, olderThan), notLatest));

        // 先数再改,**不用 `UPDATE … RETURNING`**:那个数要进 cron 日志(清了多少是唯一能看出它
        // 在干活的信号),而 RETURNING 会把每一条被改的行都物化出来 —— 部署后第一趟要清掉窗口外
        // 的全部存量,一个同步了一年的账户就是几千张快照、几万条余额行,全塞进一个 Worker 的内存
        // 只为取个 `.length`。COUNT 多两次往返但恒定内存,而这是每天一次的维护动作,不赶时间。
        //
        // 计数与改动之间不是原子的(D1 无交互式事务)—— 并发写会让日志里的数差一两条。日志容得下,
        // 而两条 UPDATE 各自幂等(`note IS NOT NULL` 门着),重跑不会重复扣。
        const [snapCount] = yield* client.query((db) =>
          db
            .select({ n: count() })
            .from(snapshots)
            .where(and(isNotNull(snapshots.note), inArray(snapshots.id, stale(db)))),
        );
        const [balCount] = yield* client.query((db) =>
          db
            .select({ n: count() })
            .from(snapshotBalances)
            .where(
              and(
                isNotNull(snapshotBalances.note),
                inArray(snapshotBalances.snapshotId, stale(db)),
              ),
            ),
        );

        yield* client.batch((db) => [
          db
            .update(snapshots)
            .set({ note: null })
            .where(and(isNotNull(snapshots.note), inArray(snapshots.id, stale(db)))),
          db
            .update(snapshotBalances)
            .set({ note: null })
            .where(
              and(
                isNotNull(snapshotBalances.note),
                inArray(snapshotBalances.snapshotId, stale(db)),
              ),
            ),
        ]);
        return { snapshots: snapCount?.n ?? 0, balances: balCount?.n ?? 0 };
      }),
  };
});

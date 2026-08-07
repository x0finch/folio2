import { type BalanceKind, Note } from "@folio/connectors-basic";
import { and, asc, desc, eq, getTableColumns, gte, inArray, max } from "drizzle-orm";
import { type DbEnv, getDb } from "../connect";
import { accounts, snapshotBalances, snapshots } from "../schema";
import type { Snapshot, SnapshotBalance } from "../schema/types";
import { assertAccountOwned } from "./ownership";

// 快照 —— 一次同步落下的余额切片,以及总额 / 历史 / 分页那几条读路。

// D1 每条 SQL 最多 100 个绑定参数;snapshot_balances 现在每行 10 列 → 每块 8 行(80 个,限内)。
// **加列必须回来改这个数**:列数 × 块行数不得超 100,否则 "too many SQL variables",只在持仓多的账户上炸。
const BALANCE_INSERT_CHUNK = 8;

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

/** 一次原子写 snapshot + balances(D1 用 db.batch,无交互式事务)。返回 snapshotId。 */
export async function writeSnapshot(
  env: DbEnv,
  userId: string,
  accountId: string,
  input: WriteSnapshotInput,
): Promise<string> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  const snapshotId = crypto.randomUUID();
  const insertSnapshot = db.insert(snapshots).values({
    id: snapshotId,
    accountId,
    takenAt: input.takenAt,
    totalUsd: input.totalUsd,
    // account 级 note(Note[] 整钱包)→ JSON;空则 null。
    note: input.note && input.note.length > 0 ? JSON.stringify(input.note) : null,
  });
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
  // D1 限制每条 SQL 最多 100 个绑定参数 → 分块,每块 ≤ BALANCE_INSERT_CHUNK 行(见其定义)。
  // 一次性大 INSERT 会触发 "too many SQL variables"(地址持仓多时,如链上钱包几十上百条)。
  const balanceInserts = [];
  for (let i = 0; i < balanceRows.length; i += BALANCE_INSERT_CHUNK) {
    balanceInserts.push(
      db.insert(snapshotBalances).values(balanceRows.slice(i, i + BALANCE_INSERT_CHUNK)),
    );
  }
  // 整批原子写(D1 无交互式事务):snapshot + 各分块余额。空余额则只写 snapshot。
  await db.batch([insertSnapshot, ...balanceInserts]);
  return snapshotId;
}

export async function listSnapshotsByAccount(
  env: DbEnv,
  userId: string,
  accountId: string,
): Promise<Snapshot[]> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  return db
    .select()
    .from(snapshots)
    .where(eq(snapshots.accountId, accountId))
    .orderBy(desc(snapshots.takenAt));
}

// 历史曲线数据源:该用户全部快照的 (accountId, takenAt, totalUsd),按 takenAt 升序。
// 只取这三列、不取 balances(比 getLatestSnapshotByUser 轻);组合净值时间序列在纯函数里
// 阶梯式重建(见 apps/web buildPortfolioHistory)。
export interface SnapshotTotal {
  accountId: string;
  takenAt: number;
  totalUsd: number;
}
export function listSnapshotTotalsByUser(env: DbEnv, userId: string): Promise<SnapshotTotal[]> {
  return getDb(env)
    .select({
      accountId: snapshots.accountId,
      takenAt: snapshots.takenAt,
      totalUsd: snapshots.totalUsd,
    })
    .from(snapshots)
    .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
    .where(eq(accounts.userId, userId))
    .orderBy(asc(snapshots.takenAt));
}

// 全历史余额(跨所有快照,userId 限定):单币价值历史用 —— app 侧按代币身份归属 + 阶梯式重建
// (见 apps/web buildTokenValueHistory)。每行带其快照的 accountId/takenAt + 该余额的冻结口径列。
// 可选 since(epoch ms)裁窗口。snapshot_balances 仅按 snapshotId 建索引 → 跨快照全扫;
// 自托管单用户量级可接受(见 #121 备注),量大再议加 (account_id, taken_at) 复合索引。
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
export function listSnapshotBalancesByUser(
  env: DbEnv,
  userId: string,
  since?: number,
): Promise<SnapshotBalanceHistoryRow[]> {
  return getDb(env)
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
    .orderBy(asc(snapshots.takenAt));
}

/**
 * 该用户每个账户的最新快照 + 其余额(总览数据源)。
 * 常数次查询(与账户数无关):① 每账户最新快照整行 ② 这些快照的全部余额,再 JS 分组。
 */
export async function getLatestSnapshotByUser(
  env: DbEnv,
  userId: string,
): Promise<SnapshotWithBalances[]> {
  const db = getDb(env);

  // 子查询:该用户每个账户的最新 takenAt(经 snapshots ⨝ accounts 用 userId 限定)。
  const latestPerAccount = db
    .select({
      accountId: snapshots.accountId,
      maxTakenAt: max(snapshots.takenAt).as("max_taken_at"),
    })
    .from(snapshots)
    .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
    .where(eq(accounts.userId, userId))
    .groupBy(snapshots.accountId)
    .as("latest_per_account");

  // ① 取每账户最新快照整行(1 查询);无快照的账户自然不出现。
  const latestSnapshots = await db
    .select(getTableColumns(snapshots))
    .from(snapshots)
    .innerJoin(
      latestPerAccount,
      and(
        eq(snapshots.accountId, latestPerAccount.accountId),
        eq(snapshots.takenAt, latestPerAccount.maxTakenAt),
      ),
    );

  // 同毫秒并列保护:每账户保留一条(id 最大者)。
  const byAccount = new Map<string, Snapshot>();
  for (const s of latestSnapshots) {
    const cur = byAccount.get(s.accountId);
    if (!cur || s.id > cur.id) byAccount.set(s.accountId, s);
  }
  const snaps = [...byAccount.values()];
  if (snaps.length === 0) return [];

  // ② 取这些快照的全部余额(1 查询)。
  const balanceRows = await db
    .select()
    .from(snapshotBalances)
    .where(
      inArray(
        snapshotBalances.snapshotId,
        snaps.map((s) => s.id),
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
}

// 导出用:分页取该用户全部快照(按 takenAt,id 稳定排序)。配合 listBalancesForSnapshots 一页页流式
// 读出,内存恒定;每页配 inArray(≤ 页大小)取余额,避开 D1 100 绑定参数上限。
export function listSnapshotsPageByUser(
  env: DbEnv,
  userId: string,
  limit: number,
  offset: number,
): Promise<Snapshot[]> {
  return getDb(env)
    .select(getTableColumns(snapshots))
    .from(snapshots)
    .innerJoin(accounts, eq(accounts.id, snapshots.accountId))
    .where(eq(accounts.userId, userId))
    .orderBy(asc(snapshots.takenAt), asc(snapshots.id))
    .limit(limit)
    .offset(offset);
}

// 取指定快照的余额。调用方须保证 ids 数量 ≤ 分页大小(< D1 100 绑定参数上限)。
// 导出(#204)按 token_id 走(v3),不再需要 symbol,故这里不再 join tokens。
export function listBalancesForSnapshots(
  env: DbEnv,
  snapshotIds: string[],
): Promise<SnapshotBalance[]> {
  if (snapshotIds.length === 0) return Promise.resolve([]);
  return getDb(env)
    .select()
    .from(snapshotBalances)
    .where(inArray(snapshotBalances.snapshotId, snapshotIds));
}

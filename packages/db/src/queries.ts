import type { AccountType, BalanceKind } from "@folio/core";
import { and, asc, desc, eq, getTableColumns, inArray, max } from "drizzle-orm";
import { type Db, type DbEnv, getDb } from "./client";
import { accountGroups, accounts, groups, snapshotBalances, snapshots } from "./schema";
import type { AccountSafe, Group, Snapshot, SnapshotBalance } from "./schema-types";

// D1 每条 SQL 最多 100 个绑定参数;snapshot_balances 每行 8 列 → 每块最多 12 行(96 参数,留余量)。
const BALANCE_INSERT_CHUNK = 12;

// 安全列:不含密文 encCredentials,常规查询一律走这组列。
// dataJson 非密钥(明文持仓),随安全形状一并返回,供 sync 组装 FetchContext。
const accountSafeColumns = {
  id: accounts.id,
  userId: accounts.userId,
  type: accounts.type,
  network: accounts.network,
  label: accounts.label,
  dataJson: accounts.dataJson,
  createdAt: accounts.createdAt,
};

// 归属校验:确保资源属于该 userId,否则抛错(从 API 形状上杜绝越权)。
async function assertAccountOwned(db: Db, userId: string, accountId: string): Promise<void> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
  if (!rows[0]) throw new Error(`account not found: ${accountId}`);
}

async function assertGroupOwned(db: Db, userId: string, groupId: string): Promise<void> {
  const rows = await db
    .select({ id: groups.id })
    .from(groups)
    .where(and(eq(groups.id, groupId), eq(groups.userId, userId)));
  if (!rows[0]) throw new Error(`group not found: ${groupId}`);
}

// ---------- 账户 ----------

export interface CreateAccountInput {
  type: AccountType;
  network?: string;
  label: string;
  encCredentials: string; // 调用方传入的密文 blob(db 不加密、不解释)
  dataJson?: string; // 非密钥账户数据的明文 JSON(manual 持仓),可空;db 不解释
}

export async function createAccount(
  env: DbEnv,
  userId: string,
  input: CreateAccountInput,
): Promise<AccountSafe> {
  const db = getDb(env);
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const network = input.network ?? null;
  const dataJson = input.dataJson ?? null;
  await db.insert(accounts).values({
    id,
    userId,
    type: input.type,
    network,
    label: input.label,
    encCredentials: input.encCredentials,
    dataJson,
    createdAt,
  });
  return { id, userId, type: input.type, network, label: input.label, dataJson, createdAt };
}

export function listAccountsByUser(env: DbEnv, userId: string): Promise<AccountSafe[]> {
  return getDb(env).select(accountSafeColumns).from(accounts).where(eq(accounts.userId, userId));
}

export async function getAccountById(
  env: DbEnv,
  userId: string,
  id: string,
): Promise<AccountSafe | null> {
  const rows = await getDb(env)
    .select(accountSafeColumns)
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
  return rows[0] ?? null;
}

/** 取密文供取数时解密用(内部接口,返回密文而非明文)。 */
export async function getEncryptedCredentials(
  env: DbEnv,
  userId: string,
  id: string,
): Promise<string | null> {
  const rows = await getDb(env)
    .select({ encCredentials: accounts.encCredentials })
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
  return rows[0]?.encCredentials ?? null;
}

/** 删账户:其 accountGroups 配对与 snapshots(及 snapshotBalances)经 ON DELETE CASCADE 级联删除。 */
export async function deleteAccount(env: DbEnv, userId: string, id: string): Promise<void> {
  await getDb(env)
    .delete(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
}

// ---------- 组 ----------

export interface CreateGroupInput {
  name: string;
  sortOrder?: number;
}

export async function createGroup(
  env: DbEnv,
  userId: string,
  input: CreateGroupInput,
): Promise<Group> {
  const db = getDb(env);
  const id = crypto.randomUUID();
  const sortOrder = input.sortOrder ?? 0;
  await db.insert(groups).values({ id, userId, name: input.name, sortOrder });
  return { id, userId, name: input.name, sortOrder };
}

export function listGroupsByUser(env: DbEnv, userId: string): Promise<Group[]> {
  return getDb(env).select().from(groups).where(eq(groups.userId, userId));
}

/** 删组:只删该组及其 accountGroups 配对(账户本身不动)。 */
export async function deleteGroup(env: DbEnv, userId: string, id: string): Promise<void> {
  await getDb(env)
    .delete(groups)
    .where(and(eq(groups.id, id), eq(groups.userId, userId)));
}

// ---------- 账户↔组 多对多 ----------

export async function addAccountToGroup(
  env: DbEnv,
  userId: string,
  accountId: string,
  groupId: string,
): Promise<void> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  await assertGroupOwned(db, userId, groupId);
  await db.insert(accountGroups).values({ accountId, groupId }).onConflictDoNothing();
}

export async function removeAccountFromGroup(
  env: DbEnv,
  userId: string,
  accountId: string,
  groupId: string,
): Promise<void> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  await db
    .delete(accountGroups)
    .where(and(eq(accountGroups.accountId, accountId), eq(accountGroups.groupId, groupId)));
}

export async function listGroupsByAccount(
  env: DbEnv,
  userId: string,
  accountId: string,
): Promise<Group[]> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  return db
    .select(getTableColumns(groups))
    .from(groups)
    .innerJoin(accountGroups, eq(accountGroups.groupId, groups.id))
    .where(and(eq(accountGroups.accountId, accountId), eq(groups.userId, userId)));
}

export async function listAccountsByGroup(
  env: DbEnv,
  userId: string,
  groupId: string,
): Promise<AccountSafe[]> {
  const db = getDb(env);
  await assertGroupOwned(db, userId, groupId);
  return db
    .select(accountSafeColumns)
    .from(accounts)
    .innerJoin(accountGroups, eq(accountGroups.accountId, accounts.id))
    .where(and(eq(accountGroups.groupId, groupId), eq(accounts.userId, userId)));
}

// 该用户的全部 账户↔组 关联(总览按组聚合用)。一次查询(account_groups ⨝ accounts 限 user),
// 避免按账户逐个 listGroupsByAccount 的 N+1。
export interface Membership {
  accountId: string;
  groupId: string;
}
export function listMembershipsByUser(env: DbEnv, userId: string): Promise<Membership[]> {
  return getDb(env)
    .select({ accountId: accountGroups.accountId, groupId: accountGroups.groupId })
    .from(accountGroups)
    .innerJoin(accounts, eq(accounts.id, accountGroups.accountId))
    .where(eq(accounts.userId, userId));
}

// ---------- 快照 ----------

export interface SnapshotBalanceInput {
  symbol: string;
  amount: number;
  usdValue: number;
  kind: BalanceKind;
  source: string;
  meta?: Record<string, unknown>;
}

export interface WriteSnapshotInput {
  takenAt: number;
  totalUsd: number;
  balances: SnapshotBalanceInput[];
}

export interface SnapshotWithBalances {
  snapshot: Snapshot;
  balances: SnapshotBalance[];
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
  const insertSnapshot = db
    .insert(snapshots)
    .values({ id: snapshotId, accountId, takenAt: input.takenAt, totalUsd: input.totalUsd });
  const balanceRows = input.balances.map((b) => ({
    id: crypto.randomUUID(),
    snapshotId,
    symbol: b.symbol,
    amount: b.amount,
    usdValue: b.usdValue,
    kind: b.kind,
    source: b.source,
    metaJson: b.meta ? JSON.stringify(b.meta) : null,
  }));
  // D1 限制每条 SQL 最多 100 个绑定参数;snapshot_balances 每行 8 列 → 分块,每块 ≤ BALANCE_INSERT_CHUNK 行。
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

  // JS 按 snapshotId 分组。
  const bySnapshot = new Map<string, SnapshotBalance[]>();
  for (const b of balanceRows) {
    const arr = bySnapshot.get(b.snapshotId);
    if (arr) arr.push(b);
    else bySnapshot.set(b.snapshotId, [b]);
  }
  return snaps.map((snapshot) => ({ snapshot, balances: bySnapshot.get(snapshot.id) ?? [] }));
}

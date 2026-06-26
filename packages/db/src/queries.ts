import type { AccountType, BalanceKind } from "@folio/core";
import { and, desc, eq, getTableColumns } from "drizzle-orm";
import { type Db, type DbEnv, getDb } from "./client";
import { accountGroups, accounts, groups, snapshotBalances, snapshots } from "./schema";
import type { AccountSafe, Group, Snapshot, SnapshotBalance } from "./schema-types";

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
  if (input.balances.length === 0) {
    await db.batch([insertSnapshot]);
    return snapshotId;
  }
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
  await db.batch([insertSnapshot, db.insert(snapshotBalances).values(balanceRows)]);
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

/** 该用户每个账户的最新快照 + 其余额(总览数据源)。 */
export async function getLatestSnapshotByUser(
  env: DbEnv,
  userId: string,
): Promise<SnapshotWithBalances[]> {
  const db = getDb(env);
  const userAccounts = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(eq(accounts.userId, userId));
  const result: SnapshotWithBalances[] = [];
  for (const account of userAccounts) {
    const latest = await db
      .select()
      .from(snapshots)
      .where(eq(snapshots.accountId, account.id))
      .orderBy(desc(snapshots.takenAt))
      .limit(1);
    const snapshot = latest[0];
    if (!snapshot) continue;
    const balances = await db
      .select()
      .from(snapshotBalances)
      .where(eq(snapshotBalances.snapshotId, snapshot.id));
    result.push({ snapshot, balances });
  }
  return result;
}

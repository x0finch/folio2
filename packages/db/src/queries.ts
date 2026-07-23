import type { ConnectorId } from "@folio/connectors";
import { type BalanceKind, Note } from "@folio/connectors-basic";
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  gte,
  type InferSelectModel,
  inArray,
  max,
} from "drizzle-orm";
import { type Db, type DbEnv, getDb } from "./client";
import {
  accountGroups,
  accounts,
  groups,
  manualActivity,
  manualToken,
  snapshotBalances,
  snapshots,
  userSettings,
} from "./schema";
import type {
  AccountSafe,
  Group,
  Snapshot,
  SnapshotBalance,
  UserSettings,
  ValuationMode,
} from "./schema-types";

// D1 每条 SQL 最多 100 个绑定参数;snapshot_balances 每行 10 列 → 每块 10 行(100 参数上限内)。
const BALANCE_INSERT_CHUNK = 10;

// 安全列:不含 creds(内含 secret 密文),常规查询一律走这组列。
const accountSafeColumns = {
  id: accounts.id,
  userId: accounts.userId,
  connectorId: accounts.connectorId,
  network: accounts.network,
  label: accounts.label,
  createdAt: accounts.createdAt,
  archivedAt: accounts.archivedAt,
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
  connectorId: ConnectorId;
  network?: string;
  label: string;
  creds: string | null; // 凭据 map 的 JSON(db 不解释);缺凭据态由 isComplete(inputs, creds) 在内存判定
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
  await db.insert(accounts).values({
    id,
    userId,
    connectorId: input.connectorId,
    network,
    label: input.label,
    creds: input.creds,
    createdAt,
  });
  return {
    id,
    userId,
    connectorId: input.connectorId,
    network,
    label: input.label,
    createdAt,
    archivedAt: null,
  };
}

export function listAccountsByUser(env: DbEnv, userId: string): Promise<AccountSafe[]> {
  return getDb(env).select(accountSafeColumns).from(accounts).where(eq(accounts.userId, userId));
}

// 补录/再水合:整张 creds map 覆盖写入(占位被真值替换,见 P6.6.1 provideCredentials)。
export async function setAccountCredentials(
  env: DbEnv,
  userId: string,
  id: string,
  creds: string,
): Promise<void> {
  await getDb(env)
    .update(accounts)
    .set({ creds })
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
}

// ⚠️ 系统级查询 —— 原则 #6(全部按 userId 作用域)的【唯一、受控例外】,仅供定时同步调度器(P6.3)
// 跨用户枚举。不接受/不返回任何用户数据,只回有账户的去重 userId 列表供逐个 syncUser。
// 不要在请求处理(server fn)里调用它。
export async function listUserIdsWithAccounts(env: DbEnv): Promise<string[]> {
  const rows = await getDb(env).selectDistinct({ userId: accounts.userId }).from(accounts);
  return rows.map((r) => r.userId);
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

/** 取原始 creds map(JSON 字符串,含 secret 密文)供 sync 解密 / 服务端投影用(内部接口,绝不裸出网)。 */
export async function getRawCreds(env: DbEnv, userId: string, id: string): Promise<string | null> {
  const rows = await getDb(env)
    .select({ creds: accounts.creds })
    .from(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
  return rows[0]?.creds ?? null;
}

// 批量取该用户全部账户的原始 creds(server 端富化 listMyAccounts 用:算 needsCredentials + safeView)。
// 返回含 secret 密文,只在服务端用、投影后才出网。
export interface AccountRawCreds {
  id: string;
  creds: string | null;
}
export function listRawCredsByUser(env: DbEnv, userId: string): Promise<AccountRawCreds[]> {
  return getDb(env)
    .select({ id: accounts.id, creds: accounts.creds })
    .from(accounts)
    .where(eq(accounts.userId, userId));
}

/** 改账户 label(userId 范围)。 */
export async function renameAccount(
  env: DbEnv,
  userId: string,
  id: string,
  label: string,
): Promise<void> {
  await getDb(env)
    .update(accounts)
    .set({ label })
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
}

/** 归档/取消归档(userId 范围):archived=true 写当前时刻,false 置 null。可逆,不删数据。 */
export async function setArchived(
  env: DbEnv,
  userId: string,
  id: string,
  archived: boolean,
): Promise<void> {
  await getDb(env)
    .update(accounts)
    .set({ archivedAt: archived ? Date.now() : null })
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
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
  selfPrice?: number; // provider 自带单价(估值原料,Phase 3);落 snapshot_balances.self_price
  tokenKey?: string;
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
    symbol: b.symbol,
    amount: b.amount,
    usdValue: b.usdValue,
    kind: b.kind,
    selfPrice: b.selfPrice ?? null,
    tokenKey: b.tokenKey ?? null,
    metaJson: b.meta ? JSON.stringify(b.meta) : null,
    // balance 级 note(单个 Note)→ JSON;无则 null。
    note: b.note ? JSON.stringify(b.note) : null,
  }));
  // D1 限制每条 SQL 最多 100 个绑定参数;snapshot_balances 每行 10 列 → 分块,每块 ≤ BALANCE_INSERT_CHUNK 行。
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
  symbol: string;
  amount: number;
  usdValue: number;
  kind: BalanceKind;
  tokenKey: string | null;
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
      symbol: snapshotBalances.symbol,
      amount: snapshotBalances.amount,
      usdValue: snapshotBalances.usdValue,
      kind: snapshotBalances.kind,
      tokenKey: snapshotBalances.tokenKey,
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

// ---------- manual 多 token tokens + 活动账本(P7.4.1 / ADR 0017)----------

// 一个账户下某 token 归属本人即返回其 accountId,否则抛(token ⨝ account ⨝ user)。
async function assertTokenOwned(db: Db, userId: string, tokenId: string): Promise<string> {
  const rows = await db
    .select({ accountId: manualToken.accountId })
    .from(manualToken)
    .innerJoin(accounts, eq(manualToken.accountId, accounts.id))
    .where(and(eq(manualToken.id, tokenId), eq(accounts.userId, userId)));
  if (!rows[0]) throw new Error(`manual token not found: ${tokenId}`);
  return rows[0].accountId;
}

export type ManualToken = InferSelectModel<typeof manualToken>;
export interface ManualTokenInput {
  symbol: string;
  unitPrice: number;
  identifier?: string | null;
}

export async function createManualToken(
  env: DbEnv,
  userId: string,
  accountId: string,
  input: ManualTokenInput,
): Promise<ManualToken> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  const row = {
    id: crypto.randomUUID(),
    accountId,
    symbol: input.symbol,
    unitPrice: input.unitPrice,
    identifier: input.identifier ?? null,
    createdAt: Date.now(),
  };
  await db.insert(manualToken).values(row);
  return row;
}

// userId-scoped(经 account ⨝ user 归属);按 created_at 升序(稳定的展示序)。
export function listManualTokensByAccount(
  env: DbEnv,
  userId: string,
  accountId: string,
): Promise<ManualToken[]> {
  return getDb(env)
    .select(getTableColumns(manualToken))
    .from(manualToken)
    .innerJoin(accounts, eq(manualToken.accountId, accounts.id))
    .where(and(eq(manualToken.accountId, accountId), eq(accounts.userId, userId)))
    .orderBy(asc(manualToken.createdAt));
}

export async function updateManualToken(
  env: DbEnv,
  userId: string,
  tokenId: string,
  input: ManualTokenInput,
): Promise<void> {
  const db = getDb(env);
  await assertTokenOwned(db, userId, tokenId);
  await db
    .update(manualToken)
    .set({
      symbol: input.symbol,
      unitPrice: input.unitPrice,
      identifier: input.identifier ?? null,
    })
    .where(eq(manualToken.id, tokenId));
}

export async function deleteManualToken(
  env: DbEnv,
  userId: string,
  tokenId: string,
): Promise<void> {
  const db = getDb(env);
  await assertTokenOwned(db, userId, tokenId);
  await db.delete(manualToken).where(eq(manualToken.id, tokenId)); // 活动经 token_id FK 级联清
}

export type ManualActivityKind = "add" | "reduce" | "set";
export interface ManualActivityInput {
  kind: ManualActivityKind;
  amount: number;
  price?: number | null;
  fee?: number | null; // 手续费 USD(可空;不参与折叠)
  occurredAt: number;
  memo?: string | null; // 用户手写备注(原 note;note 让给 provider 展示概念)
}
export type ManualActivity = InferSelectModel<typeof manualActivity>;

// 活动挂 token(ADR 0017)。accountId 由 token **反查**(assertTokenOwned)而非调用方另传 ——
// 既保证 activity.accountId 恒 === token.accountId,又杜绝「传自己的 accountId + 他人的 tokenId」把活动
// 挂到别账户/别用户 token 的越权面(不属本人的 token 直接抛)。
export async function recordManualActivity(
  env: DbEnv,
  userId: string,
  tokenId: string,
  input: ManualActivityInput,
): Promise<void> {
  const db = getDb(env);
  const accountId = await assertTokenOwned(db, userId, tokenId);
  await db.insert(manualActivity).values({
    id: crypto.randomUUID(),
    accountId,
    tokenId,
    kind: input.kind,
    amount: input.amount,
    price: input.price ?? null,
    fee: input.fee ?? null,
    occurredAt: input.occurredAt,
    memo: input.memo ?? null,
    createdAt: Date.now(),
  });
}

// userId-scoped(经 token ⨝ account ⨝ user 归属);按 occurred_at→created_at 升序(deriveAmount 据此定序)。
export function listManualActivityByToken(
  env: DbEnv,
  userId: string,
  tokenId: string,
): Promise<ManualActivity[]> {
  return getDb(env)
    .select(getTableColumns(manualActivity))
    .from(manualActivity)
    .innerJoin(manualToken, eq(manualActivity.tokenId, manualToken.id))
    .innerJoin(accounts, eq(manualToken.accountId, accounts.id))
    .where(and(eq(manualActivity.tokenId, tokenId), eq(accounts.userId, userId)))
    .orderBy(asc(manualActivity.occurredAt), asc(manualActivity.createdAt));
}

// userId-scoped(经 account ⨝ user 归属);按 occurred_at→created_at 升序(deriveAmount 据此定序)。
export function listManualActivityByAccount(
  env: DbEnv,
  userId: string,
  accountId: string,
): Promise<ManualActivity[]> {
  return getDb(env)
    .select(getTableColumns(manualActivity))
    .from(manualActivity)
    .innerJoin(accounts, eq(manualActivity.accountId, accounts.id))
    .where(and(eq(manualActivity.accountId, accountId), eq(accounts.userId, userId)))
    .orderBy(asc(manualActivity.occurredAt), asc(manualActivity.createdAt));
}

export async function removeManualActivity(
  env: DbEnv,
  userId: string,
  accountId: string,
  id: string,
): Promise<void> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  await db
    .delete(manualActivity)
    .where(and(eq(manualActivity.id, id), eq(manualActivity.accountId, accountId)));
}

// token → 其账户 id(userId-scoped 归属校验)。写路径改完 token 后据此重跑该账户物化(app 层)。
export async function getManualTokenAccountId(
  env: DbEnv,
  userId: string,
  tokenId: string,
): Promise<string> {
  return assertTokenOwned(getDb(env), userId, tokenId);
}

// 活动 → {tokenId, accountId}(经 activity ⨝ account ⨝ user 归属校验;活动可能无 tokenId 的遗留行 → 抛)。
// 编辑活动前用它定位所属 token(取时间线校验)+ 账户(重跑物化)。
async function assertActivityOwned(
  db: Db,
  userId: string,
  activityId: string,
): Promise<{ tokenId: string; accountId: string }> {
  const rows = await db
    .select({ tokenId: manualActivity.tokenId, accountId: manualActivity.accountId })
    .from(manualActivity)
    .innerJoin(accounts, eq(manualActivity.accountId, accounts.id))
    .where(and(eq(manualActivity.id, activityId), eq(accounts.userId, userId)));
  const row = rows[0];
  if (!row?.tokenId) throw new Error(`manual activity not found: ${activityId}`);
  return { tokenId: row.tokenId, accountId: row.accountId };
}

// 活动 → {tokenId, accountId}(公开读,归属校验)。编辑活动前用它取所属 token 校验超支(改前折叠)。
export function getManualActivityOwner(
  env: DbEnv,
  userId: string,
  activityId: string,
): Promise<{ tokenId: string; accountId: string }> {
  return assertActivityOwned(getDb(env), userId, activityId);
}

export interface ManualActivityPatch {
  kind?: ManualActivityKind;
  amount?: number;
  price?: number | null;
  fee?: number | null;
  occurredAt?: number;
  memo?: string | null;
}
// 编辑一笔既有活动(保留 id/tokenId/accountId/createdAt;只覆盖给定字段)。返回其 {tokenId, accountId}
// 供调用方重跑物化。归属经 assertActivityOwned;超支校验在 app 层(改前折叠受影响 token 时间线)。
export async function updateManualActivity(
  env: DbEnv,
  userId: string,
  activityId: string,
  patch: ManualActivityPatch,
): Promise<{ tokenId: string; accountId: string }> {
  const db = getDb(env);
  const owner = await assertActivityOwned(db, userId, activityId);
  const set: Partial<InferSelectModel<typeof manualActivity>> = {};
  if (patch.kind !== undefined) set.kind = patch.kind;
  if (patch.amount !== undefined) set.amount = patch.amount;
  if (patch.price !== undefined) set.price = patch.price;
  if (patch.fee !== undefined) set.fee = patch.fee;
  if (patch.occurredAt !== undefined) set.occurredAt = patch.occurredAt;
  if (patch.memo !== undefined) set.memo = patch.memo;
  // 空 patch → 无字段可写。drizzle 对空 set 会抛 "No values to set" → 直接短路(归属已校验)。
  if (Object.keys(set).length > 0) {
    await db.update(manualActivity).set(set).where(eq(manualActivity.id, activityId));
  }
  return owner;
}

export interface ManualBatchPlan {
  accountId: string;
  newTokens: { id: string; symbol: string; unitPrice: number; identifier?: string | null }[];
  activities: {
    tokenId: string;
    kind: ManualActivityKind;
    amount: number;
    price?: number | null;
    fee?: number | null;
    occurredAt: number;
    memo?: string | null;
  }[];
}
// 批量提交写计划(app 层 planManualBatch 产出):新建 token + 插入活动,**整批原子**(D1 无交互式事务 → db.batch)。
// 归属:assertAccountOwned + 校验每条活动的 tokenId ∈(该账户既有 token ∪ 本批新建)—— 杜绝把活动挂到
// 他账户/他人 token 的越权面(app 已按 account 作用域解析,此为纵深防御)。活动 createdAt = now + i 保提交序
// (同 occurredAt 处新活动恒排在既有之后,与 planManualBatch 校验时间线定序一致)。
export async function commitManualBatch(
  env: DbEnv,
  userId: string,
  plan: ManualBatchPlan,
): Promise<void> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, plan.accountId);
  const existing = await db
    .select({ id: manualToken.id })
    .from(manualToken)
    .where(eq(manualToken.accountId, plan.accountId));
  const allowed = new Set<string>([
    ...existing.map((r) => r.id),
    ...plan.newTokens.map((t) => t.id),
  ]);
  for (const a of plan.activities) {
    if (!allowed.has(a.tokenId)) throw new Error(`token not in account: ${a.tokenId}`);
  }
  const now = Date.now();
  const stmts = [
    ...plan.newTokens.map((t) =>
      db.insert(manualToken).values({
        id: t.id,
        accountId: plan.accountId,
        symbol: t.symbol,
        unitPrice: t.unitPrice,
        identifier: t.identifier ?? null,
        createdAt: now,
      }),
    ),
    ...plan.activities.map((a, i) =>
      db.insert(manualActivity).values({
        id: crypto.randomUUID(),
        accountId: plan.accountId,
        tokenId: a.tokenId,
        kind: a.kind,
        amount: a.amount,
        price: a.price ?? null,
        fee: a.fee ?? null,
        occurredAt: a.occurredAt,
        memo: a.memo ?? null,
        createdAt: now + i,
      }),
    ),
  ];
  if (stmts.length === 0) return;
  const [first, ...rest] = stmts;
  await db.batch([first, ...rest]);
}

// —— user settings(Phase 3,#82)——
// 缺省:无行的用户 → self-first(= 旧行为)。db 层不耦合 @folio/oracle,就地写常量。
// 运行时换价源(active_vendor)已废止(ADR 0014)—— CoinGecko 单源,仅留估值模式。
const DEFAULT_VALUATION_MODE: ValuationMode = "self-first";

export interface UserSettingsView {
  valuationMode: ValuationMode;
}

// 读带缺省:无行返默认(不为每个用户强制建行)。
export async function getUserSettings(env: DbEnv, userId: string): Promise<UserSettingsView> {
  const rows = await getDb(env).select().from(userSettings).where(eq(userSettings.userId, userId));
  const r = rows[0] as UserSettings | undefined;
  return {
    valuationMode: r?.valuationMode ?? DEFAULT_VALUATION_MODE,
  };
}

// upsert:只覆盖给定字段(缺省字段首次建行用默认值,后续保持原值)。
export async function updateUserSettings(
  env: DbEnv,
  userId: string,
  patch: { valuationMode?: ValuationMode },
): Promise<void> {
  const now = Date.now();
  const set: Partial<{ valuationMode: ValuationMode; updatedAt: number }> = {
    updatedAt: now,
  };
  if (patch.valuationMode !== undefined) set.valuationMode = patch.valuationMode;
  await getDb(env)
    .insert(userSettings)
    .values({
      userId,
      valuationMode: patch.valuationMode ?? DEFAULT_VALUATION_MODE,
      updatedAt: now,
    })
    .onConflictDoUpdate({ target: userSettings.userId, set });
}

import type { ConnectorId } from "@folio/connectors";
import { type BalanceKind, Note } from "@folio/connectors-basic";
import { formatTokenRef, type TokenRef } from "@folio/oracle-ref";
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
  sql,
} from "drizzle-orm";
import { type Db, type DbEnv, getDb } from "./client";
import {
  accountGroups,
  accounts,
  groups,
  manualActivity,
  snapshotBalances,
  snapshots,
  tokenRefs,
  tokens,
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

// D1 每条 SQL 最多 100 个绑定参数;snapshot_balances 现在每行 12 列 → 每块 8 行(96 个,限内)。
// **加列必须回来改这个数**:12 × 9 = 108 就会 "too many SQL variables",而且只在持仓多的账户上炸。
const BALANCE_INSERT_CHUNK = 8;

// 安全列:不含 creds(内含 secret 密文),常规查询一律走这组列。
const accountSafeColumns = {
  id: accounts.id,
  userId: accounts.userId,
  connectorId: accounts.connectorId,
  platform: accounts.platform,
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
  platform?: string;
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
  const platform = input.platform ?? null;
  await db.insert(accounts).values({
    id,
    userId,
    connectorId: input.connectorId,
    platform,
    label: input.label,
    creds: input.creds,
    createdAt,
  });
  return {
    id,
    userId,
    connectorId: input.connectorId,
    platform,
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
  // 这笔持仓所在的链 ∪ 场馆,provider 直接报(ADR 0021 / #193)。可选:同步恒会给,
  // 但导入旧版本文件(v2 没有这个字段)时缺席 —— 与列本身可空同一个理由。
  platform?: string;
  selfPrice?: number; // provider 自带单价(估值原料,Phase 3);落 snapshot_balances.self_price
  tokenRef?: string;
  // 认定冻进快照(ADR 0021 / #200):写快照前经 mint 换出的代币行 id。
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
    symbol: b.symbol,
    amount: b.amount,
    usdValue: b.usdValue,
    kind: b.kind,
    selfPrice: b.selfPrice ?? null,
    tokenRef: b.tokenRef ?? null,
    platform: b.platform ?? null,
    tokenId: b.tokenId ?? null,
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
  symbol: string;
  amount: number;
  usdValue: number;
  kind: BalanceKind;
  tokenId: string | null; // 归并身份(写快照时 mint 定死);单币历史按它归属(#201)
  tokenRef: string | null;
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
      symbol: snapshotBalances.symbol,
      amount: snapshotBalances.amount,
      usdValue: snapshotBalances.usdValue,
      kind: snapshotBalances.kind,
      tokenId: snapshotBalances.tokenId,
      tokenRef: snapshotBalances.tokenRef,
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

// ---------- manual 持仓 + 活动账本(P7.4.1 / ADR 0017;#203 起并入 tokens)----------
//
// **手记的币就是这个用户 `tokens` 里的一行**(#203):身份 / 名字 / 图 / 上游 ref 在 `tokens` +
// `token_refs`,用户声明的单价在 `tokens.self_price`,数量由 `manual_activity` 折叠。
// 原来的 `manual_token` 表整个退场 —— 那四个值全部有了真表的家。
//
// 于是「这个手记账户持有哪些币」不再单独存一份关系,而是**它账本里出现过的 token**。
// 副作用是「清空某个币」= 删掉该账户对它的全部活动(见 detachManualHolding),而 `tokens` 那行留着 ——
// 它是参考层数据,可能别的账户还在用,也可能上游认识它。

// 该 token 归属本人即通过,否则抛。`tokens` 直接带 user_id,不必再绕 account。
async function assertTokenOwned(db: Db, userId: string, tokenId: string): Promise<void> {
  const rows = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.id, tokenId), eq(tokens.userId, userId)));
  if (!rows[0]) throw new Error(`token not found: ${tokenId}`);
}

// 手记持仓的定义投影(数量不在内 —— 那是账本折叠出来的)。`id` 就是 `tokens.id`。
export interface ManualHolding {
  id: string;
  symbol: string;
  // = tokens.self_price。**空 = 从没声明过**,不塌成 0 —— 那会把「没填」和「填了个 0」
  // 混成一件事,而展示那一侧要靠这个区分决定退不退到账本价(见 fallbackUnitPrice)。
  unitPrice: number | null;
  // 这个 token 在 `namer` 那里的 **ref 整条**;那位命名者还没认出它 → null。
  //
  // **给整条,不给右半边。** 原来这里回的是裸的上游 id(`usd-coin`),于是每个调用方都得把 ref
  // 拼回去才能用 —— 而拼 ref 就得知道命名者是谁,于是「当前上游是 CoinGecko」这件事一路漏进了
  // apps/web(#227 评审)。整条给出去之后调用方只搬运:编成票、或当 Balance 的 tokenRef 交出去,
  // 一个字都不用解释。文法留在 `@folio/oracle-ref` 这一侧,`namer` 也不必再往外说。
  ref: TokenRef | null;
}

// 某手记账户的持仓定义。`namer` 决定 `ref` 从哪个命名者那一行读 —— 由调用方传
// (同 createUserTokenStore),db 层不预设任何厂商。
// 序:该币在本账户账本里最早一笔活动的时间 —— 即「什么时候开始持有它」,天然稳定。
export async function listManualHoldingsByAccount(
  env: DbEnv,
  userId: string,
  accountId: string,
  namer: string,
): Promise<ManualHolding[]> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  const rows = await db
    .select({
      id: tokens.id,
      symbol: tokens.symbol,
      selfPrice: tokens.selfPrice,
      localName: tokenRefs.localName,
      since: sql<number>`min(${manualActivity.occurredAt})`,
    })
    .from(manualActivity)
    .innerJoin(tokens, eq(manualActivity.tokenId, tokens.id))
    .leftJoin(
      tokenRefs,
      and(
        eq(tokenRefs.tokenId, tokens.id),
        eq(tokenRefs.userId, userId),
        eq(tokenRefs.namer, namer),
      ),
    )
    .where(and(eq(manualActivity.accountId, accountId), eq(tokens.userId, userId)))
    .groupBy(tokens.id, tokens.symbol, tokens.selfPrice, tokenRefs.localName)
    .orderBy(asc(sql`min(${manualActivity.occurredAt})`));
  return rows.map((r) => ({
    id: r.id,
    symbol: r.symbol,
    unitPrice: r.selfPrice,
    // 两列 → 整条串,拼法归文法(`token_refs` 按两列存正是为了这个,见 ADR 0022)。
    ref: r.localName === null ? null : formatTokenRef({ namer, localName: r.localName }),
  }));
}

// 用户对某个币的声明:symbol(他自己的叫法)+ 单价。**只动这两列** —— 名字 / 图 / 上游 ref
// 归参考层,手记不覆盖它们。
export async function setManualHoldingDef(
  env: DbEnv,
  userId: string,
  tokenId: string,
  input: { symbol?: string; unitPrice?: number },
): Promise<void> {
  const db = getDb(env);
  await assertTokenOwned(db, userId, tokenId);
  const set: Record<string, unknown> = {};
  if (input.symbol !== undefined) set.symbol = input.symbol;
  if (input.unitPrice !== undefined) set.selfPrice = input.unitPrice;
  if (Object.keys(set).length === 0) return;
  await db
    .update(tokens)
    .set(set)
    .where(and(eq(tokens.id, tokenId), eq(tokens.userId, userId)));
}

// 该账户不再持有这个币:删它对该币的全部活动。**`tokens` 那行不删** —— 参考层数据,
// 别的账户可能还在用,而且它带着上游 ref / 历史日价,删了就得重新认一遍。
export async function detachManualHolding(
  env: DbEnv,
  userId: string,
  accountId: string,
  tokenId: string,
): Promise<void> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  await assertTokenOwned(db, userId, tokenId);
  await db
    .delete(manualActivity)
    .where(and(eq(manualActivity.accountId, accountId), eq(manualActivity.tokenId, tokenId)));
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

// 活动挂 (账户, token)。#203 起 **accountId 由调用方显式给** —— token 不再自带账户(`tokens` 是
// per-user 的,一个币可以被多个手记账户持有),没法再从它反查。
// 越权面靠两道归属校验各自挡:账户属本人、token 属本人。缺一道就能把活动挂到别人的东西上。
export async function recordManualActivity(
  env: DbEnv,
  userId: string,
  accountId: string,
  tokenId: string,
  input: ManualActivityInput,
): Promise<void> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  await assertTokenOwned(db, userId, tokenId);
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

// 某账户对某个币的账本(userId-scoped 经 account ⨝ user);按 occurred_at→created_at 升序
// (deriveAmount 据此定序)。**必须带 accountId** —— 同一个 token 可以被多个手记账户持有,
// 只按 tokenId 取会把别的账户的活动一起折进来,数量直接算错。
export async function listManualActivityByToken(
  env: DbEnv,
  userId: string,
  accountId: string,
  tokenId: string,
): Promise<ManualActivity[]> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  return db
    .select(getTableColumns(manualActivity))
    .from(manualActivity)
    .where(and(eq(manualActivity.accountId, accountId), eq(manualActivity.tokenId, tokenId)))
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
  // 本批要**声明**的持仓:`id` 已经是 mint 出来的 `tokens.id`(app 层在提交前认好币),
  // 这里只落用户自己的两个字段。原来这叫 `newTokens` 并且真的插一张 `manual_token` 行 ——
  // 币的身份现在归参考层,不再由手记这条路创建。
  declare: { id: string; symbol: string; unitPrice: number | null }[];
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
// 批量提交写计划(app 层 planManualBatch 产出):落持仓声明 + 插入活动,**整批原子**
// (D1 无交互式事务 → db.batch)。
//
// 归属:assertAccountOwned + 校验每条活动的 tokenId **属于本人**。
// 注意闸口从「∈ 该账户既有 token」改成了「∈ 本人的 token」—— 账户与币的关系现在**由活动本身承载**,
// 拿它当前置条件会循环:一个刚声明的持仓在本批插入之前一条活动都没有。
// 用户维度的闸仍然严格:拿别人的 tokenId 来照样抛。
// 活动 createdAt = now + i 保提交序(同 occurredAt 处新活动恒排在既有之后,与 planManualBatch 定序一致)。
export async function commitManualBatch(
  env: DbEnv,
  userId: string,
  plan: ManualBatchPlan,
): Promise<void> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, plan.accountId);
  const ids = [
    ...new Set([...plan.declare.map((t) => t.id), ...plan.activities.map((a) => a.tokenId)]),
  ];
  if (ids.length > 0) {
    const owned = await db
      .select({ id: tokens.id })
      .from(tokens)
      .where(and(eq(tokens.userId, userId), inArray(tokens.id, ids)));
    const ok = new Set(owned.map((r) => r.id));
    for (const id of ids) if (!ok.has(id)) throw new Error(`token not owned: ${id}`);
  }
  const now = Date.now();
  const stmts = [
    ...plan.declare.map((t) =>
      db
        .update(tokens)
        .set({ symbol: t.symbol, selfPrice: t.unitPrice })
        .where(and(eq(tokens.id, t.id), eq(tokens.userId, userId))),
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

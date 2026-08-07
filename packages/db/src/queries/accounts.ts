import type { ConnectorId } from "@folio/connectors";
import { and, eq } from "drizzle-orm";
import { type DbEnv, getDb } from "../client";
import { accounts, portfolioAccounts } from "../schema";
import type { AccountSafe } from "../schema-types";
import { ensureDefaultPortfolio } from "./portfolios";

// 账户:建 / 列 / 改名 / 归档 / 删,外加 creds 的原样存取(db 不解释 creds 的内容)。

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
  // 不变量(ADR 0033):每个账户恰一行归属。新账户落进用户的默认 Portfolio —— 建账户与建归属
  // 一个 batch 原子写,杜绝「有账户没归属」的空窗(否则该账户会从 accountsInView 里消失)。
  const pf = await ensureDefaultPortfolio(env, userId);
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const platform = input.platform ?? null;
  await db.batch([
    db.insert(accounts).values({
      id,
      userId,
      connectorId: input.connectorId,
      platform,
      label: input.label,
      creds: input.creds,
      createdAt,
    }),
    db.insert(portfolioAccounts).values({ portfolioId: pf.id, accountId: id }),
  ]);
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

/** 删账户:其 snapshots / portfolio_accounts / manual_activity 经 ON DELETE CASCADE 级联删除。 */
export async function deleteAccount(env: DbEnv, userId: string, id: string): Promise<void> {
  await getDb(env)
    .delete(accounts)
    .where(and(eq(accounts.id, id), eq(accounts.userId, userId)));
}

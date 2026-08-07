import { and, asc, eq } from "drizzle-orm";
import { type Db, type DbEnv, getDb } from "../client";
import { accounts, accountTags, portfolioAccounts, portfolios, user } from "../schema";
import type { Portfolio } from "../schema-types";
import { assertAccountOwned, assertPortfolioOwned } from "./ownership";

// Portfolio —— 命名账户集(ADR 0033)。每个账户恰属一个,新用户首次落地建默认那个。

// 默认 Portfolio 名:`<用户名>'s`,用户名为空兜底 `My Portfolio`。
// **必须与迁移 0003 的 seed SQL 保持一致**(那里对存量用户 seed 同名规则)。
const PORTFOLIO_NAME_SUFFIX = "'s";
const PORTFOLIO_FALLBACK_NAME = "My Portfolio";
function defaultPortfolioName(userName: string | null | undefined): string {
  const n = (userName ?? "").trim();
  return n ? `${n}${PORTFOLIO_NAME_SUFFIX}` : PORTFOLIO_FALLBACK_NAME;
}

function selectDefaultPortfolio(db: Db, userId: string): Promise<Portfolio | undefined> {
  return db
    .select()
    .from(portfolios)
    .where(and(eq(portfolios.userId, userId), eq(portfolios.isDefault, true)))
    .limit(1)
    .then((rows) => rows[0]);
}

// 拿该用户的默认 Portfolio,没有就建一个(find-or-create,幂等)。存量用户由迁移 seed、
// 新用户在此首次落地。名字取自 user.name(见 defaultPortfolioName)。
// onConflictDoNothing + 事后重查:并发下两个实例都「查不到→插」时,唯一索引让其一失败、两者都拿回同一行。
export async function ensureDefaultPortfolio(env: DbEnv, userId: string): Promise<Portfolio> {
  const db = getDb(env);
  const found = await selectDefaultPortfolio(db, userId);
  if (found) return found;
  const named = await db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1);
  await db
    .insert(portfolios)
    .values({
      id: crypto.randomUUID(),
      userId,
      name: defaultPortfolioName(named[0]?.name),
      isDefault: true,
      sortOrder: 0,
      createdAt: Date.now(),
    })
    .onConflictDoNothing();
  const after = await selectDefaultPortfolio(db, userId);
  if (!after) throw new Error(`failed to ensure default portfolio for user ${userId}`);
  return after;
}

// 该用户的全部 Portfolio,按**创建时间**稳定排序(不把默认置顶 —— 切换默认时列表不重排;ADR 0033)。
// id 作最终 tiebreaker,避免同毫秒 createdAt 的顺序不确定。
export function listPortfoliosByUser(env: DbEnv, userId: string): Promise<Portfolio[]> {
  return getDb(env)
    .select()
    .from(portfolios)
    .where(eq(portfolios.userId, userId))
    .orderBy(asc(portfolios.sortOrder), asc(portfolios.createdAt), asc(portfolios.id));
}

// 该用户全部 账户→Portfolio 归属(accountsInView 的过滤原料)。一次查询(portfolio_accounts ⨝ accounts 限 user)。
export interface PortfolioMembership {
  accountId: string;
  portfolioId: string;
}
export function listPortfolioMembershipsByUser(
  env: DbEnv,
  userId: string,
): Promise<PortfolioMembership[]> {
  return getDb(env)
    .select({
      accountId: portfolioAccounts.accountId,
      portfolioId: portfolioAccounts.portfolioId,
    })
    .from(portfolioAccounts)
    .innerJoin(accounts, eq(accounts.id, portfolioAccounts.accountId))
    .where(eq(accounts.userId, userId));
}

// 建一个**命名(非默认)** Portfolio(选择器「新建…」/「移到→新建」用)。默认 Portfolio 只由
// ensureDefaultPortfolio 造,这里永不建默认(is_default=false),故不碰部分唯一索引。
export async function createPortfolio(
  env: DbEnv,
  userId: string,
  input: { name: string; sortOrder?: number },
): Promise<Portfolio> {
  const id = crypto.randomUUID();
  const createdAt = Date.now();
  const sortOrder = input.sortOrder ?? 0;
  const row = {
    id,
    userId,
    name: input.name,
    isDefault: false,
    sortOrder,
    createdAt,
  };
  await getDb(env).insert(portfolios).values(row);
  return row;
}

// 把账户归属到某 Portfolio(一对一:先删该账户现有归属行,再插新的,一个 batch 原子换)。
// 两个资源都做 owner 断言,杜绝越权。
// **同 batch 清空该账户的全部 Tag**(ADR 0034):Tag 属于原 Portfolio,搬家后对新家是外来的,
// 带过去会破坏「账户只有其所在 Portfolio 的 Tag」这条不变量 —— 故随归属变更一并清掉,新家里重新打。
export async function assignAccountToPortfolio(
  env: DbEnv,
  userId: string,
  accountId: string,
  portfolioId: string,
): Promise<void> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  await assertPortfolioOwned(db, userId, portfolioId);
  // 已在目标 Portfolio → 真 no-op。否则下面的「清空该账户 Tag」会在没真搬家时也误删标签
  // (重新指到当前 Portfolio 本应无副作用)。
  const current = await db
    .select({ portfolioId: portfolioAccounts.portfolioId })
    .from(portfolioAccounts)
    .where(eq(portfolioAccounts.accountId, accountId));
  if (current[0]?.portfolioId === portfolioId) return;
  await db.batch([
    db.delete(portfolioAccounts).where(eq(portfolioAccounts.accountId, accountId)),
    db.insert(portfolioAccounts).values({ portfolioId, accountId }),
    db.delete(accountTags).where(eq(accountTags.accountId, accountId)),
  ]);
}

// 改 Portfolio 名(含默认,因它是真行)。userId 作用域,越权即影响 0 行。
export async function renamePortfolio(
  env: DbEnv,
  userId: string,
  portfolioId: string,
  name: string,
): Promise<void> {
  await getDb(env)
    .update(portfolios)
    .set({ name })
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)));
}

// 设为默认:先清掉该用户当前默认(→ 无默认),再把目标置默认(→ 恰一个)。两步一个 batch 原子换,
// 中途不出现「两个默认」违反部分唯一索引。
export async function setDefaultPortfolio(
  env: DbEnv,
  userId: string,
  portfolioId: string,
): Promise<void> {
  const db = getDb(env);
  await assertPortfolioOwned(db, userId, portfolioId);
  await db.batch([
    db
      .update(portfolios)
      .set({ isDefault: false })
      .where(and(eq(portfolios.userId, userId), eq(portfolios.isDefault, true))),
    db
      .update(portfolios)
      .set({ isDefault: true })
      .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
  ]);
}

// 删 Portfolio:默认不可删(抛)。否则先把成员退回默认 Portfolio,再删该行(成员账户不动、不孤儿)。
export async function deletePortfolio(
  env: DbEnv,
  userId: string,
  portfolioId: string,
): Promise<void> {
  const db = getDb(env);
  const rows = await db
    .select({ isDefault: portfolios.isDefault })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)));
  const target = rows[0];
  if (!target) throw new Error(`portfolio not found: ${portfolioId}`);
  if (target.isDefault) throw new Error("cannot delete the default portfolio");
  const def = await ensureDefaultPortfolio(env, userId);
  await db.batch([
    // 成员退回默认(1:1 不冲突:成员在 target,不在 default → 改指 default 无碰撞)。
    db
      .update(portfolioAccounts)
      .set({ portfolioId: def.id })
      .where(eq(portfolioAccounts.portfolioId, portfolioId)),
    db.delete(portfolios).where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
  ]);
}

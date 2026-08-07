import { and, asc, eq, sql } from "drizzle-orm";
import { type Db, type DbEnv, getDb } from "../client";
import { accounts, accountTags, portfolioAccounts, tags } from "../schema";
import type { Tag } from "../schema-types";
import { assertAccountOwned, assertPortfolioOwned, assertTagOwned } from "./ownership";

// Tag —— Portfolio 内的软标签(ADR 0034)。一个账户可挂多个,但只能挂同 Portfolio 的 tag。

// 某账户当前归属的 Portfolio(1:1,恰一行;无行 = 账户不存在 / 越权,返回 undefined)。
async function accountPortfolioId(db: Db, accountId: string): Promise<string | undefined> {
  const rows = await db
    .select({ portfolioId: portfolioAccounts.portfolioId })
    .from(portfolioAccounts)
    .where(eq(portfolioAccounts.accountId, accountId));
  return rows[0]?.portfolioId;
}

// 同 Portfolio 内名字空闲校验(忽略大小写;可排除自身 id 供改名用)。DB 表达式唯一索引兜底并发,
// 这里给出更友好的报错并先挡单实例的重复。
async function assertTagNameFree(
  db: Db,
  userId: string,
  portfolioId: string,
  name: string,
  exceptTagId?: string,
): Promise<void> {
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(
      and(
        eq(tags.userId, userId),
        eq(tags.portfolioId, portfolioId),
        sql`lower(${tags.name}) = lower(${name})`,
      ),
    );
  if (rows.some((r) => r.id !== exceptTagId)) {
    throw new Error(`tag name already exists in portfolio: ${name}`);
  }
}

export interface CreateTagInput {
  portfolioId: string;
  name: string;
  sortOrder?: number;
}

// 建一个 Tag(归属指定 Portfolio)。名字 trim 后落库、同 Portfolio 内忽略大小写唯一。
export async function createTag(env: DbEnv, userId: string, input: CreateTagInput): Promise<Tag> {
  const db = getDb(env);
  await assertPortfolioOwned(db, userId, input.portfolioId);
  const name = input.name.trim();
  if (!name) throw new Error("tag name must not be empty");
  await assertTagNameFree(db, userId, input.portfolioId, name);
  const row = {
    id: crypto.randomUUID(),
    userId,
    portfolioId: input.portfolioId,
    name,
    sortOrder: input.sortOrder ?? 0,
    createdAt: Date.now(),
  };
  await db.insert(tags).values(row);
  return row;
}

// 该用户全部 Tag(展示富化用:一次拿到 id→{name,portfolioId} 供账户行/抽屉渲染)。
export function listTagsByUser(env: DbEnv, userId: string): Promise<Tag[]> {
  return getDb(env)
    .select()
    .from(tags)
    .where(eq(tags.userId, userId))
    .orderBy(asc(tags.sortOrder), asc(tags.createdAt), asc(tags.id));
}

// 某 Portfolio 内的 Tag(打标签弹窗:平铺当前 Portfolio 的可选 Tag)。
export function listTagsByPortfolio(
  env: DbEnv,
  userId: string,
  portfolioId: string,
): Promise<Tag[]> {
  return getDb(env)
    .select()
    .from(tags)
    .where(and(eq(tags.userId, userId), eq(tags.portfolioId, portfolioId)))
    .orderBy(asc(tags.sortOrder), asc(tags.createdAt), asc(tags.id));
}

// 改 Tag 名(同 Portfolio 内唯一校验,排除自身)。userId 作用域,越权即 tag not found。
export async function renameTag(
  env: DbEnv,
  userId: string,
  tagId: string,
  name: string,
): Promise<void> {
  const db = getDb(env);
  const { portfolioId } = await assertTagOwned(db, userId, tagId);
  const next = name.trim();
  if (!next) throw new Error("tag name must not be empty");
  await assertTagNameFree(db, userId, portfolioId, next, tagId);
  await db
    .update(tags)
    .set({ name: next })
    .where(and(eq(tags.id, tagId), eq(tags.userId, userId)));
}

// 删 Tag(Portfolio 级破坏性):其 account_tags 与 tab_pins(#343 后)经 FK cascade 一并清。
export async function deleteTag(env: DbEnv, userId: string, tagId: string): Promise<void> {
  await getDb(env)
    .delete(tags)
    .where(and(eq(tags.id, tagId), eq(tags.userId, userId)));
}

// 给账户打上一个 Tag(幂等:已打 → no-op)。校验账户与 Tag 同 Portfolio(ADR 0034 不变量)。
export async function attachTag(
  env: DbEnv,
  userId: string,
  accountId: string,
  tagId: string,
): Promise<void> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  const { portfolioId: tagPortfolio } = await assertTagOwned(db, userId, tagId);
  const accPortfolio = await accountPortfolioId(db, accountId);
  if (accPortfolio !== tagPortfolio) {
    throw new Error("tag and account belong to different portfolios");
  }
  await db.insert(accountTags).values({ tagId, accountId }).onConflictDoNothing();
}

// 从账户取消一个 Tag(幂等)。两个资源都做 owner 断言。
export async function detachTag(
  env: DbEnv,
  userId: string,
  accountId: string,
  tagId: string,
): Promise<void> {
  const db = getDb(env);
  await assertAccountOwned(db, userId, accountId);
  await assertTagOwned(db, userId, tagId);
  await db
    .delete(accountTags)
    .where(and(eq(accountTags.tagId, tagId), eq(accountTags.accountId, accountId)));
}

export interface AccountTagLink {
  accountId: string;
  tagId: string;
}

// 该用户全部 账户→Tag 关联(展示富化原料)。一次查询(account_tags ⨝ accounts 限 user)。
export function listAccountTagsByUser(env: DbEnv, userId: string): Promise<AccountTagLink[]> {
  return getDb(env)
    .select({ accountId: accountTags.accountId, tagId: accountTags.tagId })
    .from(accountTags)
    .innerJoin(accounts, eq(accounts.id, accountTags.accountId))
    .where(eq(accounts.userId, userId));
}

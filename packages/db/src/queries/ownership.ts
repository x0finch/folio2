import { and, eq } from "drizzle-orm";
import type { Db } from "../client";
import { accounts, portfolios, tags, tokens } from "../schema";

// 归属校验 —— 这半数据访问的越权防线,四个领域共用。
//
// 每个都是同一句话:这东西属不属于这个 userId?不属于就抛。单独放一处是因为它们跨领域被用 ——
// 账户那道被 portfolio / tag / tab pin / 快照 / 手记五处调,token 那道被手记与导入两处调。

export async function assertAccountOwned(db: Db, userId: string, accountId: string): Promise<void> {
  const rows = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId)));
  if (!rows[0]) throw new Error(`account not found: ${accountId}`);
}

export async function assertPortfolioOwned(
  db: Db,
  userId: string,
  portfolioId: string,
): Promise<void> {
  const rows = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId)));
  if (!rows[0]) throw new Error(`portfolio not found: ${portfolioId}`);
}

export async function assertTagOwned(
  db: Db,
  userId: string,
  tagId: string,
): Promise<{ portfolioId: string }> {
  const rows = await db
    .select({ portfolioId: tags.portfolioId })
    .from(tags)
    .where(and(eq(tags.id, tagId), eq(tags.userId, userId)));
  const row = rows[0];
  if (!row) throw new Error(`tag not found: ${tagId}`);
  return row;
}

// 该 token 归属本人即通过,否则抛。`tokens` 直接带 user_id,不必再绕 account。
export async function assertTokenOwned(db: Db, userId: string, tokenId: string): Promise<void> {
  const rows = await db
    .select({ id: tokens.id })
    .from(tokens)
    .where(and(eq(tokens.id, tokenId), eq(tokens.userId, userId)));
  if (!rows[0]) throw new Error(`token not found: ${tokenId}`);
}

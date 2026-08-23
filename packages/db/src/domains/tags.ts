import { and, asc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import { DbClient } from "../client";
import type { Drizzle } from "../connect";
import { CurrentUser } from "../current-user";
import type { NotFound } from "../errors";
import { accounts, accountTags, portfolioAccounts, tags } from "../schema";
import type { Tag } from "../schema/types";
import { assertAccountOwned, assertPortfolioOwned, assertTagOwned } from "./ownership";

// Tag —— Portfolio 内的软标签(ADR 0034)。一个账户可挂多个,但只能挂同 Portfolio 的 tag。
//
// **服务的方法签名里没有 userId**(ADR 0037):由 `TagStore.Default(userId)` 在装配那一刻吃掉。

// 某账户当前归属的 Portfolio(1:1,恰一行;无行 = 账户不存在 / 越权,返回 undefined)。
async function accountPortfolioId(db: Drizzle, accountId: string): Promise<string | undefined> {
  const rows = await db
    .select({ portfolioId: portfolioAccounts.portfolioId })
    .from(portfolioAccounts)
    .where(eq(portfolioAccounts.accountId, accountId));
  return rows[0]?.portfolioId;
}

// 同 Portfolio 内名字空闲校验(忽略大小写;可排除自身 id 供改名用)。DB 表达式唯一索引兜底并发,
// 这里给出更友好的报错并先挡单实例的重复。
async function assertTagNameFree(
  db: Drizzle,
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

export interface AccountTagLink {
  accountId: string;
  tagId: string;
}

export const makeTagStore = Effect.gen(function* () {
  const client = yield* DbClient;
  const userId = yield* CurrentUser;

  return {
    /** 建一个 Tag(归属指定 Portfolio)。名字 trim 后落库、同 Portfolio 内忽略大小写唯一。 */
    create: (input: CreateTagInput): Effect.Effect<Tag, NotFound> =>
      Effect.gen(function* () {
        yield* assertPortfolioOwned(client, userId, input.portfolioId);
        const name = input.name.trim();
        if (!name) return yield* Effect.die(new Error("tag name must not be empty"));
        yield* client.query((db) => assertTagNameFree(db, userId, input.portfolioId, name));
        const row = {
          id: crypto.randomUUID(),
          userId,
          portfolioId: input.portfolioId,
          name,
          sortOrder: input.sortOrder ?? 0,
          createdAt: Date.now(),
        };
        yield* client.query((db) => db.insert(tags).values(row));
        return row;
      }),

    /** 全部 Tag(展示富化用:一次拿到 id→{name,portfolioId} 供账户行/抽屉渲染)。 */
    list: (): Effect.Effect<Tag[]> =>
      client.query((db) =>
        db
          .select()
          .from(tags)
          .where(eq(tags.userId, userId))
          .orderBy(asc(tags.sortOrder), asc(tags.createdAt), asc(tags.id)),
      ),

    /** 某 Portfolio 内的 Tag(打标签弹窗:平铺当前 Portfolio 的可选 Tag)。 */
    listByPortfolio: (portfolioId: string): Effect.Effect<Tag[]> =>
      client.query((db) =>
        db
          .select()
          .from(tags)
          .where(and(eq(tags.userId, userId), eq(tags.portfolioId, portfolioId)))
          .orderBy(asc(tags.sortOrder), asc(tags.createdAt), asc(tags.id)),
      ),

    /** 改 Tag 名(同 Portfolio 内唯一校验,排除自身)。越权即 tag not found。 */
    rename: (tagId: string, name: string): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        const { portfolioId } = yield* assertTagOwned(client, userId, tagId);
        const next = name.trim();
        if (!next) return yield* Effect.die(new Error("tag name must not be empty"));
        yield* client.query((db) => assertTagNameFree(db, userId, portfolioId, next, tagId));
        yield* client.query((db) =>
          db
            .update(tags)
            .set({ name: next })
            .where(and(eq(tags.id, tagId), eq(tags.userId, userId))),
        );
      }),

    /** 删 Tag(Portfolio 级破坏性):其 account_tags 与 tab_pins(#343 后)经 FK cascade 一并清。 */
    remove: (tagId: string): Effect.Effect<void> =>
      Effect.asVoid(
        client.query((db) =>
          db.delete(tags).where(and(eq(tags.id, tagId), eq(tags.userId, userId))),
        ),
      ),

    /** 给账户打上一个 Tag(幂等)。校验账户与 Tag 同 Portfolio(ADR 0034 不变量)。 */
    attach: (accountId: string, tagId: string): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        const { portfolioId: tagPortfolio } = yield* assertTagOwned(client, userId, tagId);
        const accPortfolio = yield* client.query((db) => accountPortfolioId(db, accountId));
        if (accPortfolio !== tagPortfolio) {
          return yield* Effect.die(new Error("tag and account belong to different portfolios"));
        }
        yield* client.query((db) =>
          db.insert(accountTags).values({ tagId, accountId }).onConflictDoNothing(),
        );
      }),

    /** 从账户取消一个 Tag(幂等)。两个资源都做 owner 断言。 */
    detach: (accountId: string, tagId: string): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        yield* assertTagOwned(client, userId, tagId);
        yield* client.query((db) =>
          db
            .delete(accountTags)
            .where(and(eq(accountTags.tagId, tagId), eq(accountTags.accountId, accountId))),
        );
      }),

    /** 全部 账户→Tag 关联(展示富化原料)。一次查询(account_tags ⨝ accounts 限 user)。 */
    listAccountLinks: (): Effect.Effect<AccountTagLink[]> =>
      client.query((db) =>
        db
          .select({ accountId: accountTags.accountId, tagId: accountTags.tagId })
          .from(accountTags)
          .innerJoin(accounts, eq(accounts.id, accountTags.accountId))
          .where(eq(accounts.userId, userId)),
      ),
  };
});

// 过渡壳。app 里还有调用点写着 `yield* TagStore`,挂进聚合 `Database` 之后(#504 T7–T12)
// 它们会一处不剩,这个 class 随之删除 —— 留下的就是上面那个 make,tab-pins 今天的形状。
export class TagStore extends Effect.Service<TagStore>()("db/TagStore", {
  effect: makeTagStore,
}) {}

import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { DbClient } from "../client";
import { NotFound } from "../errors";
import { accounts, portfolios, tags, tokens } from "../schema";

// 归属校验 —— 这半数据访问的越权防线,四个领域共用。
//
// 每个都是同一句话:这东西属不属于这个 userId?不属于就 fail `NotFound`。单独放一处是因为
// 它们跨领域被用 —— 账户那道被 portfolio / tag / tab pin / 快照 / 手记五处调,token 那道被
// 手记与导入两处调。
//
// **不属于本人 = 不存在**,一个错误两种情形:分开报等于给出一个探测别人 id 的接口(见 ../errors.ts)。
//
// 收的是 `DbClient` 而不是 drizzle 句柄(#504 T5)。以前是 `client.query((db) => assertX(db, …))`
// —— 断言写在 promise 里,「越权」于是只能靠 `throw` 表达,落地成 defect,跟「代码写错了」
// 在类型上没有区别。现在它自己就是 effect,失败在 `E` 通道里,调用点也短了一层。

// 「查到就过,查不到就 NotFound」—— 四道断言唯一的差别只是查哪张表。
const requireRow = <A>(
  entity: string,
  id: string,
  rows: readonly A[],
): Effect.Effect<A, NotFound> => {
  const row = rows[0];
  return row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity, id }));
};

export const assertAccountOwned = (
  client: DbClient,
  userId: string,
  accountId: string,
): Effect.Effect<void, NotFound> =>
  client
    .query((db) =>
      db
        .select({ id: accounts.id })
        .from(accounts)
        .where(and(eq(accounts.id, accountId), eq(accounts.userId, userId))),
    )
    .pipe(
      Effect.flatMap((rows) => requireRow("account", accountId, rows)),
      Effect.asVoid,
    );

export const assertPortfolioOwned = (
  client: DbClient,
  userId: string,
  portfolioId: string,
): Effect.Effect<void, NotFound> =>
  client
    .query((db) =>
      db
        .select({ id: portfolios.id })
        .from(portfolios)
        .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
    )
    .pipe(
      Effect.flatMap((rows) => requireRow("portfolio", portfolioId, rows)),
      Effect.asVoid,
    );

// 这一道**顺带把 portfolioId 带回来** —— 调用方拿它做同 Portfolio 校验(ADR 0034 不变量),
// 不必再查一次。
export const assertTagOwned = (
  client: DbClient,
  userId: string,
  tagId: string,
): Effect.Effect<{ portfolioId: string }, NotFound> =>
  client
    .query((db) =>
      db
        .select({ portfolioId: tags.portfolioId })
        .from(tags)
        .where(and(eq(tags.id, tagId), eq(tags.userId, userId))),
    )
    .pipe(Effect.flatMap((rows) => requireRow("tag", tagId, rows)));

// 该 token 归属本人即通过。`tokens` 直接带 user_id,不必再绕 account。
export const assertTokenOwned = (
  client: DbClient,
  userId: string,
  tokenId: string,
): Effect.Effect<void, NotFound> =>
  client
    .query((db) =>
      db
        .select({ id: tokens.id })
        .from(tokens)
        .where(and(eq(tokens.id, tokenId), eq(tokens.userId, userId))),
    )
    .pipe(
      Effect.flatMap((rows) => requireRow("token", tokenId, rows)),
      Effect.asVoid,
    );

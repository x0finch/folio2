import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { DbClient } from "../client";
import { NotFound } from "../errors";
import { accounts, portfolios, tags, tokens } from "../schema";

// Ownership checks shared across domains (one file, to avoid an accounts <-> portfolios cycle).
// Not owned = not found: one error for both cases, so other users' ids can't be probed.

const requireRow = <A>(
  entity: string,
  id: string,
  rows: readonly A[],
): Effect.Effect<A, NotFound> => {
  const row = rows[0];
  return row ? Effect.succeed(row) : Effect.fail(new NotFound({ entity, id }));
};

export const assertAccountOwned = (
  client: DbClient["Service"],
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
  client: DbClient["Service"],
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

// Also returns portfolioId so callers can check the same-portfolio invariant without another read.
export const assertTagOwned = (
  client: DbClient["Service"],
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

// `tokens` carries user_id directly, so no join through accounts.
export const assertTokenOwned = (
  client: DbClient["Service"],
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

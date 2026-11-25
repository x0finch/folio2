import { and, asc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DbClient } from "../client";
import type { Drizzle } from "../connect";
import { InvalidInput, type NotFound } from "../errors";
import { accounts, accountTags, portfolioAccounts, tags } from "../schema";
import type { Tag } from "../schema/types";
import { assertAccountOwned, assertPortfolioOwned, assertTagOwned } from "./ownership";

// Tags are soft labels within a portfolio; an account can only carry tags of its own portfolio.

// undefined = no membership row (account missing or not owned).
async function accountPortfolioId(db: Drizzle, accountId: string): Promise<string | undefined> {
  const rows = await db
    .select({ portfolioId: portfolioAccounts.portfolioId })
    .from(portfolioAccounts)
    .where(eq(portfolioAccounts.accountId, accountId));
  return rows[0]?.portfolioId;
}

// Case-insensitive; the unique expression index covers races, this just gives a readable error.
// Returns a boolean so a duplicate name becomes a typed failure, not a defect.
async function tagNameTaken(
  db: Drizzle,
  userId: string,
  portfolioId: string,
  name: string,
  exceptTagId?: string,
): Promise<boolean> {
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
  return rows.some((r) => r.id !== exceptTagId);
}

const nameTaken = (name: string) =>
  new InvalidInput({ what: "tag", why: `name already used in this portfolio: ${name}` });

export interface CreateTagInput {
  portfolioId: string;
  name: string;
  sortOrder?: number;
}

export interface AccountTagLink {
  accountId: string;
  tagId: string;
}

export const makeTagStore = (client: DbClient["Service"], userId: string) => {
  return {
    /** Name is trimmed and unique case-insensitively within the portfolio. */
    create: (input: CreateTagInput): Effect.Effect<Tag, NotFound | InvalidInput> =>
      Effect.gen(function* () {
        yield* assertPortfolioOwned(client, userId, input.portfolioId);
        const name = input.name.trim();
        // Still a defect: the boundary schema already trims and requires min(1).
        if (!name) return yield* Effect.die(new Error("tag name must not be empty"));
        const taken = yield* client.query((db) =>
          tagNameTaken(db, userId, input.portfolioId, name),
        );
        if (taken) return yield* Effect.fail(nameTaken(name));
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

    list: (): Effect.Effect<Tag[]> =>
      client.query((db) =>
        db
          .select()
          .from(tags)
          .where(eq(tags.userId, userId))
          .orderBy(asc(tags.sortOrder), asc(tags.createdAt), asc(tags.id)),
      ),

    listByPortfolio: (portfolioId: string): Effect.Effect<Tag[]> =>
      client.query((db) =>
        db
          .select()
          .from(tags)
          .where(and(eq(tags.userId, userId), eq(tags.portfolioId, portfolioId)))
          .orderBy(asc(tags.sortOrder), asc(tags.createdAt), asc(tags.id)),
      ),

    rename: (tagId: string, name: string): Effect.Effect<void, NotFound | InvalidInput> =>
      Effect.gen(function* () {
        const { portfolioId } = yield* assertTagOwned(client, userId, tagId);
        const next = name.trim();
        if (!next) return yield* Effect.die(new Error("tag name must not be empty"));
        const taken = yield* client.query((db) =>
          tagNameTaken(db, userId, portfolioId, next, tagId),
        );
        if (taken) return yield* Effect.fail(nameTaken(next));
        yield* client.query((db) =>
          db
            .update(tags)
            .set({ name: next })
            .where(and(eq(tags.id, tagId), eq(tags.userId, userId))),
        );
      }),

    /** account_tags and tab_pins rows go with it via FK cascade. */
    remove: (tagId: string): Effect.Effect<void> =>
      Effect.asVoid(
        client.query((db) =>
          db.delete(tags).where(and(eq(tags.id, tagId), eq(tags.userId, userId))),
        ),
      ),

    /** Idempotent. */
    attach: (accountId: string, tagId: string): Effect.Effect<void, NotFound | InvalidInput> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        const { portfolioId: tagPortfolio } = yield* assertTagOwned(client, userId, tagId);
        const accPortfolio = yield* client.query((db) => accountPortfolioId(db, accountId));
        // Reachable from a stale page or a second window, so a typed failure rather than a defect.
        if (accPortfolio !== tagPortfolio) {
          return yield* Effect.fail(
            new InvalidInput({
              what: "tag",
              why: "tag and account are in different portfolios",
            }),
          );
        }
        yield* client.query((db) =>
          db.insert(accountTags).values({ tagId, accountId }).onConflictDoNothing(),
        );
      }),

    /** Idempotent. */
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

    listAccountLinks: (): Effect.Effect<AccountTagLink[]> =>
      client.query((db) =>
        db
          .select({ accountId: accountTags.accountId, tagId: accountTags.tagId })
          .from(accountTags)
          .innerJoin(accounts, eq(accounts.id, accountTags.accountId))
          .where(eq(accounts.userId, userId)),
      ),
  };
};

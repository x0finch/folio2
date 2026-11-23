import { and, asc, eq, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DbClient } from "../client";
import type { Drizzle } from "../connect";
import { InvalidInput, NotFound } from "../errors";
import { accounts, accountTags, portfolioAccounts, portfolios, user } from "../schema";
import type { Portfolio } from "../schema/types";
import { assertAccountOwned, assertPortfolioOwned } from "./ownership";

// Portfolio: a named set of accounts; every account belongs to exactly one.

// `<user name>'s`, falling back to `My Portfolio`. Must match the seed SQL in migration 0003.
const PORTFOLIO_NAME_SUFFIX = "'s";
const PORTFOLIO_FALLBACK_NAME = "My Portfolio";
function defaultPortfolioName(userName: string | null | undefined): string {
  const n = (userName ?? "").trim();
  return n ? `${n}${PORTFOLIO_NAME_SUFFIX}` : PORTFOLIO_FALLBACK_NAME;
}

// Case-insensitive. The unique index `portfolios_user_name_uidx` covers races; this gives a
// readable error first.
async function nameTaken(
  db: Drizzle,
  userId: string,
  name: string,
  exceptId?: string,
): Promise<boolean> {
  const rows = await db
    .select({ id: portfolios.id })
    .from(portfolios)
    .where(
      and(
        eq(portfolios.userId, userId),
        // Must match the index expression exactly, or a name passing here collides on insert.
        sql`lower(trim(${portfolios.name})) = lower(trim(${name}))`,
      ),
    );
  return rows.some((r) => r.id !== exceptId);
}

const NAME_TAKEN = (name: string) =>
  new InvalidInput({ what: "portfolio", why: `name already used: ${name}` });

// The default's name can't be rejected (the user didn't type it), so on collision append ` (2)`,
// ` (3)`, ... rather than dying on first app open.
const DEFAULT_NAME_TRIES = 20;
const freeDefaultName = (client: DbClient, userId: string, base: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    for (let n = 1; n <= DEFAULT_NAME_TRIES; n++) {
      const candidate = n === 1 ? base : `${base} (${n})`;
      if (!(yield* client.query((db) => nameTaken(db, userId, candidate)))) return candidate;
    }
    // Twenty taken means abuse, not bad data: fail with the id rather than pick a random name.
    return `${base} (${crypto.randomUUID().slice(0, 8)})`;
  });

export interface PortfolioMembership {
  accountId: string;
  portfolioId: string;
}

const selectDefault = (client: DbClient, userId: string): Effect.Effect<Portfolio | undefined> =>
  client.query((db) =>
    db
      .select()
      .from(portfolios)
      .where(and(eq(portfolios.userId, userId), eq(portfolios.isDefault, true)))
      .limit(1)
      .then((rows) => rows[0]),
  );

// Package-level so account creation can use it without depending on the portfolio store.
// ON CONFLICT DO NOTHING + re-read: under a race one insert loses and both get the same row.
export const ensureDefault = (client: DbClient, userId: string): Effect.Effect<Portfolio> =>
  Effect.gen(function* () {
    const found = yield* selectDefault(client, userId);
    if (found) return found;
    const named = yield* client.query((db) =>
      db.select({ name: user.name }).from(user).where(eq(user.id, userId)).limit(1),
    );
    const name = yield* freeDefaultName(client, userId, defaultPortfolioName(named[0]?.name));
    yield* client.query((db) =>
      db
        .insert(portfolios)
        .values({
          id: crypto.randomUUID(),
          userId,
          name,
          isDefault: true,
          sortOrder: 0,
          createdAt: Date.now(),
        })
        .onConflictDoNothing(),
    );
    const after = yield* selectDefault(client, userId);
    if (!after) {
      return yield* Effect.die(new Error(`failed to ensure default portfolio for user ${userId}`));
    }
    return after;
  });

export const makePortfolioStore = (client: DbClient, userId: string) => {
  return {
    ensureDefault: (): Effect.Effect<Portfolio> => ensureDefault(client, userId),

    // By creation time (default not pinned first, so changing it doesn't reorder); id breaks ties.
    list: (): Effect.Effect<Portfolio[]> =>
      client.query((db) =>
        db
          .select()
          .from(portfolios)
          .where(eq(portfolios.userId, userId))
          .orderBy(asc(portfolios.sortOrder), asc(portfolios.createdAt), asc(portfolios.id)),
      ),

    listMemberships: (): Effect.Effect<PortfolioMembership[]> =>
      client.query((db) =>
        db
          .select({
            accountId: portfolioAccounts.accountId,
            portfolioId: portfolioAccounts.portfolioId,
          })
          .from(portfolioAccounts)
          .innerJoin(accounts, eq(accounts.id, portfolioAccounts.accountId))
          .where(eq(accounts.userId, userId)),
      ),

    // Named portfolios only; the default is created solely by ensureDefault.
    create: (input: { name: string; sortOrder?: number }): Effect.Effect<Portfolio, InvalidInput> =>
      Effect.gen(function* () {
        // A double submit lands here too, so no separate idempotency key is needed.
        const name = input.name.trim();
        if (yield* client.query((db) => nameTaken(db, userId, name))) {
          return yield* Effect.fail(NAME_TAKEN(name));
        }
        const row = {
          id: crypto.randomUUID(),
          userId,
          name,
          isDefault: false,
          sortOrder: input.sortOrder ?? 0,
          createdAt: Date.now(),
        };
        yield* client.query((db) => db.insert(portfolios).values(row));
        return row;
      }),

    // Atomic membership swap that also clears the account's tags: tags belong to the old portfolio,
    // and an account may only carry tags of its own portfolio.
    assignAccount: (accountId: string, portfolioId: string): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        yield* assertPortfolioOwned(client, userId, portfolioId);
        // Already there -> no-op, so the tag clearing below doesn't fire on a non-move.
        const current = yield* client.query((db) =>
          db
            .select({ portfolioId: portfolioAccounts.portfolioId })
            .from(portfolioAccounts)
            .where(eq(portfolioAccounts.accountId, accountId)),
        );
        if (current[0]?.portfolioId === portfolioId) return;
        yield* client.batch((db) => [
          db.delete(portfolioAccounts).where(eq(portfolioAccounts.accountId, accountId)),
          db.insert(portfolioAccounts).values({ portfolioId, accountId }),
          db.delete(accountTags).where(eq(accountTags.accountId, accountId)),
        ]);
      }),

    // Renaming to its own current name (case/space changes) doesn't count as taken.
    rename: (portfolioId: string, name: string): Effect.Effect<void, InvalidInput> =>
      Effect.gen(function* () {
        const next = name.trim();
        if (yield* client.query((db) => nameTaken(db, userId, next, portfolioId))) {
          return yield* Effect.fail(NAME_TAKEN(next));
        }
        yield* client.query((db) =>
          db
            .update(portfolios)
            .set({ name: next })
            .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
        );
      }),

    // Clear then set in one batch, so the partial unique index never sees two defaults.
    setDefault: (portfolioId: string): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        yield* assertPortfolioOwned(client, userId, portfolioId);
        yield* client.batch((db) => [
          db
            .update(portfolios)
            .set({ isDefault: false })
            .where(and(eq(portfolios.userId, userId), eq(portfolios.isDefault, true))),
          db
            .update(portfolios)
            .set({ isDefault: true })
            .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
        ]);
      }),

    // Members move back to the default portfolio. Both rejections are typed failures: a stale page
    // can send either request.
    remove: (portfolioId: string): Effect.Effect<void, NotFound | InvalidInput> =>
      Effect.gen(function* () {
        const rows = yield* client.query((db) =>
          db
            .select({ isDefault: portfolios.isDefault })
            .from(portfolios)
            .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
        );
        const target = rows[0];
        // Missing and not-owned share NotFound so other users' ids can't be probed.
        if (!target) {
          return yield* Effect.fail(new NotFound({ entity: "portfolio", id: portfolioId }));
        }
        if (target.isDefault) {
          return yield* Effect.fail(
            new InvalidInput({ what: "portfolio", why: "the default portfolio cannot be deleted" }),
          );
        }
        const def = yield* ensureDefault(client, userId);
        yield* client.batch((db) => [
          db
            .update(portfolioAccounts)
            .set({ portfolioId: def.id })
            .where(eq(portfolioAccounts.portfolioId, portfolioId)),
          db
            .delete(portfolios)
            .where(and(eq(portfolios.id, portfolioId), eq(portfolios.userId, userId))),
        ]);
      }),
  };
};

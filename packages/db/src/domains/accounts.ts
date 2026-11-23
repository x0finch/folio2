import type { ConnectorId } from "@folio/connectors";
import { and, eq } from "drizzle-orm";
import { Effect } from "effect";
import type { DbClient } from "../client";
import { accounts, portfolioAccounts } from "../schema";
import type { AccountSafe } from "../schema/types";
import { ensureDefault } from "./portfolios";

// Excludes creds (holds secret ciphertext); regular reads use only these columns.
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
  creds: string | null; // creds map as JSON, opaque to db
}

export type AccountWithPortfolio = AccountSafe & { portfolioId: string | null };

export interface AccountRawCreds {
  id: string;
  creds: string | null;
}

// System-level query, the one controlled exception to per-user scoping: lets the scheduled sync
// enumerate users. Returns only user ids; never call it from request handlers.
export const makeGlobalAccountStore = (client: DbClient) => {
  return {
    listUserIds: (): Effect.Effect<string[]> =>
      Effect.map(
        client.query((db) => db.selectDistinct({ userId: accounts.userId }).from(accounts)),
        (rows) => rows.map((r) => r.userId),
      ),
  };
};

export const makeAccountStore = (client: DbClient, userId: string) => {
  return {
    // Invariant: every account has exactly one membership row. Insert both in one batch so the
    // account never drops out of the portfolio view.
    create: (input: CreateAccountInput): Effect.Effect<AccountSafe> =>
      Effect.gen(function* () {
        const pf = yield* ensureDefault(client, userId);
        const id = crypto.randomUUID();
        const createdAt = Date.now();
        const platform = input.platform ?? null;
        yield* client.batch((db) => [
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
      }),

    list: (): Effect.Effect<AccountSafe[]> =>
      client.query((db) =>
        db.select(accountSafeColumns).from(accounts).where(eq(accounts.userId, userId)),
      ),

    // portfolioId is null without a membership row (readers fall back to the default portfolio).
    // One joined query rather than two: every D1 round trip costs fixed Worker CPU.
    listWithPortfolio: (): Effect.Effect<AccountWithPortfolio[]> =>
      client.query((db) =>
        db
          .select({ ...accountSafeColumns, portfolioId: portfolioAccounts.portfolioId })
          .from(accounts)
          .leftJoin(portfolioAccounts, eq(portfolioAccounts.accountId, accounts.id))
          .where(eq(accounts.userId, userId)),
      ),

    getById: (id: string): Effect.Effect<AccountSafe | null> =>
      Effect.map(
        client.query((db) =>
          db
            .select(accountSafeColumns)
            .from(accounts)
            .where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
        ),
        (rows) => rows[0] ?? null,
      ),

    setCredentials: (id: string, creds: string): Effect.Effect<void> =>
      Effect.asVoid(
        client.query((db) =>
          db
            .update(accounts)
            .set({ creds })
            .where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
        ),
      ),

    /** Raw creds JSON including secret ciphertext: server-side only, never sent to the client. */
    getRawCreds: (id: string): Effect.Effect<string | null> =>
      Effect.map(
        client.query((db) =>
          db
            .select({ creds: accounts.creds })
            .from(accounts)
            .where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
        ),
        (rows) => rows[0]?.creds ?? null,
      ),

    listRawCreds: (): Effect.Effect<AccountRawCreds[]> =>
      client.query((db) =>
        db
          .select({ id: accounts.id, creds: accounts.creds })
          .from(accounts)
          .where(eq(accounts.userId, userId)),
      ),

    rename: (id: string, label: string): Effect.Effect<void> =>
      Effect.asVoid(
        client.query((db) =>
          db
            .update(accounts)
            .set({ label })
            .where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
        ),
      ),

    setArchived: (id: string, archived: boolean): Effect.Effect<void> =>
      Effect.asVoid(
        client.query((db) =>
          db
            .update(accounts)
            .set({ archivedAt: archived ? Date.now() : null })
            .where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
        ),
      ),

    /** Snapshots, memberships and manual activity go with it via ON DELETE CASCADE. */
    remove: (id: string): Effect.Effect<void> =>
      Effect.asVoid(
        client.query((db) =>
          db.delete(accounts).where(and(eq(accounts.id, id), eq(accounts.userId, userId))),
        ),
      ),
  };
};

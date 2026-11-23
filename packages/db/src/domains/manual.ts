import { formatTokenRef, type TokenRef } from "@folio/oracle-ref";
import { and, asc, eq, getTableColumns, type InferSelectModel, inArray, sql } from "drizzle-orm";
import { Effect } from "effect";
import type { DbClient } from "../client";
import { NotFound } from "../errors";
import { accounts, manualActivity, tokenRefs, tokens } from "../schema";
import { assertAccountOwned, assertTokenOwned } from "./ownership";

// Manual holdings and their activity ledger, one service: holdings are folded from the ledger.
// A manual coin is a row in the user's `tokens`; an account "holds" whatever tokens its ledger
// mentions. Clearing a holding deletes the activity only: the `tokens` row is reference data that
// other accounts or upstream refs may still use.

export interface ManualHolding {
  id: string;
  symbol: string;
  // The full ref under `namer` (null = not recognised yet), so callers never rebuild it themselves.
  ref: TokenRef | null;
}

export type ManualActivityKind = "add" | "reduce" | "set";
export interface ManualActivityInput {
  kind: ManualActivityKind;
  amount: number;
  price?: number | null;
  fee?: number | null; // USD; not part of the fold
  occurredAt: number;
  memo?: string | null;
  // Import only: keeps the original created_at so same-occurred_at fold order is preserved.
  createdAt?: number;
}
export type ManualActivity = InferSelectModel<typeof manualActivity>;

export interface ManualActivityPatch {
  kind?: ManualActivityKind;
  amount?: number;
  price?: number | null;
  fee?: number | null;
  occurredAt?: number;
  memo?: string | null;
}

export interface ManualBatchPlan {
  accountId: string;
  // Token ids are already minted by the app layer; only the user's symbol is written here.
  declare: { id: string; symbol: string }[];
  activities: {
    tokenId: string;
    kind: ManualActivityKind;
    amount: number;
    price?: number | null;
    fee?: number | null;
    occurredAt: number;
    memo?: string | null;
  }[];
}

// Legacy activity rows without a tokenId fail as `NotFound` too: either way the caller can't edit it.
const assertActivityOwned = (
  client: DbClient,
  userId: string,
  activityId: string,
): Effect.Effect<{ tokenId: string; accountId: string }, NotFound> =>
  client
    .query((db) =>
      db
        .select({ tokenId: manualActivity.tokenId, accountId: manualActivity.accountId })
        .from(manualActivity)
        .innerJoin(accounts, eq(manualActivity.accountId, accounts.id))
        .where(and(eq(manualActivity.id, activityId), eq(accounts.userId, userId))),
    )
    .pipe(
      Effect.flatMap((rows) => {
        const row = rows[0];
        return row?.tokenId
          ? Effect.succeed({ tokenId: row.tokenId, accountId: row.accountId })
          : Effect.fail(new NotFound({ entity: "manual activity", id: activityId }));
      }),
    );

export const makeManualStore = (client: DbClient, userId: string) => {
  return {
    // Ordered by first activity, i.e. when the holding started.
    listHoldings: (accountId: string, namer: string): Effect.Effect<ManualHolding[], NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        const rows = yield* client.query((db) =>
          db
            .select({
              id: tokens.id,
              symbol: tokens.symbol,
              localName: tokenRefs.localName,
              since: sql<number>`min(${manualActivity.occurredAt})`,
            })
            .from(manualActivity)
            .innerJoin(tokens, eq(manualActivity.tokenId, tokens.id))
            .leftJoin(
              tokenRefs,
              and(
                eq(tokenRefs.tokenId, tokens.id),
                eq(tokenRefs.userId, userId),
                eq(tokenRefs.namer, namer),
              ),
            )
            .where(and(eq(manualActivity.accountId, accountId), eq(tokens.userId, userId)))
            .groupBy(tokens.id, tokens.symbol, tokens.selfPrice, tokenRefs.localName)
            .orderBy(asc(sql`min(${manualActivity.occurredAt})`)),
        );
        return rows.map((r) => ({
          id: r.id,
          symbol: r.symbol,
          ref: r.localName === null ? null : formatTokenRef({ namer, localName: r.localName }),
        }));
      }),

    // Only the user's symbol: name / logo / upstream refs belong to the reference layer, and price
    // comes solely from the ledger.
    setHoldingDef: (tokenId: string, input: { symbol?: string }): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        yield* assertTokenOwned(client, userId, tokenId);
        const set: Record<string, unknown> = {};
        if (input.symbol !== undefined) set.symbol = input.symbol;
        if (Object.keys(set).length === 0) return;
        yield* client.query((db) =>
          db
            .update(tokens)
            .set(set)
            .where(and(eq(tokens.id, tokenId), eq(tokens.userId, userId))),
        );
      }),

    // The `tokens` row stays: other accounts may use it, and it carries refs and price history.
    detachHolding: (accountId: string, tokenId: string): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        yield* assertTokenOwned(client, userId, tokenId);
        yield* client.query((db) =>
          db
            .delete(manualActivity)
            .where(
              and(eq(manualActivity.accountId, accountId), eq(manualActivity.tokenId, tokenId)),
            ),
        );
      }),

    // accountId is explicit (a token can be held by several manual accounts); both ownership checks
    // are needed, or activity could be attached to someone else's account or token.
    recordActivity: (
      accountId: string,
      tokenId: string,
      input: ManualActivityInput,
    ): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        yield* assertTokenOwned(client, userId, tokenId);
        yield* client.query((db) =>
          db.insert(manualActivity).values({
            id: crypto.randomUUID(),
            accountId,
            tokenId,
            kind: input.kind,
            amount: input.amount,
            price: input.price ?? null,
            fee: input.fee ?? null,
            occurredAt: input.occurredAt,
            memo: input.memo ?? null,
            createdAt: input.createdAt ?? Date.now(),
          }),
        );
      }),

    // accountId is required: filtering by token alone would fold in other accounts' activity.
    listActivityByToken: (
      accountId: string,
      tokenId: string,
    ): Effect.Effect<ManualActivity[], NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        return yield* client.query((db) =>
          db
            .select(getTableColumns(manualActivity))
            .from(manualActivity)
            .where(
              and(eq(manualActivity.accountId, accountId), eq(manualActivity.tokenId, tokenId)),
            )
            .orderBy(asc(manualActivity.occurredAt), asc(manualActivity.createdAt)),
        );
      }),

    listActivityByAccount: (accountId: string): Effect.Effect<ManualActivity[]> =>
      client.query((db) =>
        db
          .select(getTableColumns(manualActivity))
          .from(manualActivity)
          .innerJoin(accounts, eq(manualActivity.accountId, accounts.id))
          .where(and(eq(manualActivity.accountId, accountId), eq(accounts.userId, userId)))
          .orderBy(asc(manualActivity.occurredAt), asc(manualActivity.createdAt)),
      ),

    /** For export: ids are remapped on import. */
    listAllActivity: (): Effect.Effect<ManualActivity[]> =>
      client.query((db) =>
        db
          .select(getTableColumns(manualActivity))
          .from(manualActivity)
          .innerJoin(accounts, eq(manualActivity.accountId, accounts.id))
          .where(eq(accounts.userId, userId))
          .orderBy(asc(manualActivity.occurredAt), asc(manualActivity.createdAt)),
      ),

    removeActivity: (accountId: string, id: string): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, accountId);
        yield* client.query((db) =>
          db
            .delete(manualActivity)
            .where(and(eq(manualActivity.id, id), eq(manualActivity.accountId, accountId))),
        );
      }),

    activityOwner: (
      activityId: string,
    ): Effect.Effect<{ tokenId: string; accountId: string }, NotFound> =>
      assertActivityOwned(client, userId, activityId),

    // Overspend validation happens in the app layer.
    updateActivity: (
      activityId: string,
      patch: ManualActivityPatch,
    ): Effect.Effect<{ tokenId: string; accountId: string }, NotFound> =>
      Effect.gen(function* () {
        const owner = yield* assertActivityOwned(client, userId, activityId);
        const set: Partial<InferSelectModel<typeof manualActivity>> = {};
        if (patch.kind !== undefined) set.kind = patch.kind;
        if (patch.amount !== undefined) set.amount = patch.amount;
        if (patch.price !== undefined) set.price = patch.price;
        if (patch.fee !== undefined) set.fee = patch.fee;
        if (patch.occurredAt !== undefined) set.occurredAt = patch.occurredAt;
        if (patch.memo !== undefined) set.memo = patch.memo;
        // drizzle throws "No values to set" on an empty set.
        if (Object.keys(set).length > 0) {
          yield* client.query((db) =>
            db.update(manualActivity).set(set).where(eq(manualActivity.id, activityId)),
          );
        }
        return owner;
      }),

    // Atomic. Token gate is "owned by the user", not "already held by this account": a newly declared
    // holding has no activity until this batch inserts it. createdAt = now + i keeps submit order
    // after existing rows with the same occurredAt.
    commitBatch: (plan: ManualBatchPlan): Effect.Effect<void, NotFound> =>
      Effect.gen(function* () {
        yield* assertAccountOwned(client, userId, plan.accountId);
        const ids = [
          ...new Set([...plan.declare.map((t) => t.id), ...plan.activities.map((a) => a.tokenId)]),
        ];
        if (ids.length > 0) {
          const owned = yield* client.query((db) =>
            db
              .select({ id: tokens.id })
              .from(tokens)
              .where(and(eq(tokens.userId, userId), inArray(tokens.id, ids))),
          );
          const ok = new Set(owned.map((r) => r.id));
          for (const id of ids) {
            if (!ok.has(id)) return yield* Effect.die(new Error(`token not owned: ${id}`));
          }
        }
        const now = Date.now();
        yield* client.batch((db) => [
          ...plan.declare.map((t) =>
            db
              .update(tokens)
              .set({ symbol: t.symbol })
              .where(and(eq(tokens.id, t.id), eq(tokens.userId, userId))),
          ),
          ...plan.activities.map((a, i) =>
            db.insert(manualActivity).values({
              id: crypto.randomUUID(),
              accountId: plan.accountId,
              tokenId: a.tokenId,
              kind: a.kind,
              amount: a.amount,
              price: a.price ?? null,
              fee: a.fee ?? null,
              occurredAt: a.occurredAt,
              memo: a.memo ?? null,
              createdAt: now + i,
            }),
          ),
        ]);
      }),
  };
};

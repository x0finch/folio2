import { and, eq, sql } from "drizzle-orm";
import { Clock, Effect, Option } from "effect";
import type { DbClient } from "../client";
import { userCache } from "../schema";

// Sync round state, kept server-side so cron rounds are visible and survive reloads. One
// `user_cache` key per portfolio holding the latest round.
// The heartbeat is the `expires_at` column: unfinished and expired = interrupted (the app decides).
// Every write is a single statement conditioned on the round id: D1 has no interactive transactions,
// so a stale worker's writes to a newer round simply match nothing.

export type SyncRoundTrigger = "manual" | "cron";

/**
 * `needs-keys` (no credentials yet) is neither success nor failure; `skipped` is an auto round not
 * refetching a still-fresh account (manual rounds never skip). Statuses are JSON strings, so adding one
 * needs no migration.
 */
export type SyncRoundAccountStatus = "pending" | "synced" | "failed" | "needs-keys" | "skipped";

export interface SyncRoundAccount {
  /** Frozen at round start so a later rename doesn't garble the previous round's report. */
  label: string;
  status: SyncRoundAccountStatus;
  /** Upstream message; only on `failed`. */
  error?: string;
}

/** `expiresAt` comes from the row's `expires_at` column, not the JSON. */
export interface SyncRoundRecord {
  roundId: string;
  portfolioId: string;
  trigger: SyncRoundTrigger;
  startedAt: number;
  /** null = not finished; combine with `expiresAt` to tell running from interrupted. */
  finishedAt: number | null;
  /** Round-level failure only; per-account failures live in `accounts`. */
  error?: string;
  accounts: Record<string, SyncRoundAccount>;
  expiresAt: number;
}

/**
 * `round: null` only when the row was deleted between the two statements (user cascade): there is
 * no round to report, so callers mustn't treat it as running.
 */
export type OpenSyncRoundResult =
  | { opened: true; round: SyncRoundRecord }
  | { opened: false; round: SyncRoundRecord | null };

export interface OpenSyncRoundInput {
  portfolioId: string;
  roundId: string;
  trigger: SyncRoundTrigger;
  accounts: readonly { id: string; label: string }[];
  /** Heartbeat length, chosen by the app: how long without a heartbeat counts as dead is sync policy. */
  ttlMs: number;
}

export interface SettleSyncRoundInput {
  portfolioId: string;
  roundId: string;
  accountId: string;
  status: Exclude<SyncRoundAccountStatus, "pending">;
  error?: string;
  ttlMs: number;
}

export interface EnlistSyncRoundInput {
  portfolioId: string;
  roundId: string;
  account: { id: string; label: string };
  ttlMs: number;
}

export interface TouchSyncRoundInput {
  portfolioId: string;
  roundId: string;
  ttlMs: number;
}

export interface FinishSyncRoundInput {
  portfolioId: string;
  roundId: string;
  error?: string;
  /** Longer retention after finishing; the next round overwrites the key anyway. */
  retentionMs: number;
}

const keyOf = (portfolioId: string) => `sync-round:${portfolioId}`;

type StoredRound = Omit<SyncRoundRecord, "expiresAt">;

// `json_extract` errors on malformed JSON, which would wedge this portfolio's sync forever; `iif`
// turns a bad value into "no round" so the next open overwrites it. Don't rewrite as
// `json_valid(v) AND ...`: SQLite doesn't guarantee AND/OR evaluation order.
const asJson = sql`iif(json_valid(${userCache.v}), ${userCache.v}, '{}')`;

const decode = (row: { v: string; expiresAt: number }): SyncRoundRecord | undefined => {
  try {
    const parsed = JSON.parse(row.v) as StoredRound;
    if (typeof parsed?.roundId !== "string") return undefined;
    return { ...parsed, accounts: parsed.accounts ?? {}, expiresAt: row.expiresAt };
  } catch {
    return undefined;
  }
};

export const makeSyncRoundStore = (client: DbClient, userId: string) => {
  const mine = (portfolioId: string) =>
    and(eq(userCache.userId, userId), eq(userCache.k, keyOf(portfolioId)));

  // Every write is conditioned on this, so a racing stale writer becomes a no-op.
  const sameRound = (roundId: string) => sql`json_extract(${asJson}, '$.roundId') = ${roundId}`;

  const read = (portfolioId: string): Effect.Effect<Option.Option<SyncRoundRecord>> =>
    Effect.gen(function* () {
      const rows = yield* client.query((db) =>
        db
          .select({ v: userCache.v, expiresAt: userCache.expiresAt })
          .from(userCache)
          .where(mine(portfolioId)),
      );
      const row = rows[0];
      return Option.fromNullable(row ? decode(row) : undefined);
    });

  return {
    /**
     * Idempotent: if a live round (unfinished, unexpired) exists, writes nothing and returns it.
     * The claim is one conditional upsert + RETURNING; on a loss, re-reading yields the winner's round.
     */
    open: (input: OpenSyncRoundInput): Effect.Effect<OpenSyncRoundResult> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const accounts: Record<string, SyncRoundAccount> = {};
        for (const a of input.accounts) accounts[a.id] = { label: a.label, status: "pending" };
        const fresh: StoredRound = {
          roundId: input.roundId,
          portfolioId: input.portfolioId,
          trigger: input.trigger,
          startedAt: now,
          finishedAt: null,
          accounts,
        };
        const v = JSON.stringify(fresh);
        const expiresAt = now + input.ttlMs;

        const won = yield* client.query((db) =>
          db
            .insert(userCache)
            .values({ userId, k: keyOf(input.portfolioId), v, expiresAt })
            .onConflictDoUpdate({
              target: [userCache.userId, userCache.k],
              set: { v: sql`excluded.v`, expiresAt: sql`excluded.expires_at` },
              // Overwrite unless the row holds a live round: finished, expired, or not a round at all
              // (bad JSON folds to '{}', so roundId is null; otherwise a bad value wedges opening).
              // `<=` because `expiresAt` means "alive until this instant", same as the cache.
              setWhere: sql`json_extract(${asJson}, '$.finishedAt') is not null or ${userCache.expiresAt} <= ${now} or json_extract(${asJson}, '$.roundId') is null`,
            })
            .returning({ v: userCache.v, expiresAt: userCache.expiresAt }),
        );
        const mineNow = won[0] ? decode(won[0]) : undefined;
        if (mineNow) return { round: mineNow, opened: true } as const;

        const existing = yield* read(input.portfolioId);
        return Option.match(existing, {
          // Only a concurrent delete gets here. Return null rather than `fresh`, or the client
          // would poll a round that doesn't exist.
          onNone: () => ({ round: null, opened: false as const }),
          onSome: (round) => ({ round, opened: false as const }),
        });
      }),

    /** A corrupt value reads as none; the next open overwrites it. */
    get: read,

    /**
     * Records an account's outcome and extends the heartbeat. Only `pending -> final`: unknown
     * account ids don't grow the denominator, and of two concurrent messages for one account
     * (at-least-once redelivery) the first wins. Finished rounds are untouched, so a late settle
     * can't shrink the retention back to the heartbeat TTL.
     */
    settle: (input: SettleSyncRoundInput): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        // Let SQLite quote the key rather than hand-rolling the escaping.
        const path = sql`'$.accounts.' || json_quote(${input.accountId})`;
        const next =
          input.error === undefined
            ? sql`json_set(${userCache.v}, ${path} || '.status', ${input.status})`
            : sql`json_set(${userCache.v}, ${path} || '.status', ${input.status}, ${path} || '.error', ${input.error})`;
        yield* client.query((db) =>
          db
            .update(userCache)
            .set({ v: next, expiresAt: now + input.ttlMs })
            .where(
              and(
                mine(input.portfolioId),
                sameRound(input.roundId),
                sql`json_extract(${asJson}, '$.finishedAt') is null`,
                sql`json_extract(${asJson}, ${path} || '.status') = 'pending'`,
              ),
            ),
        );
      }),

    /**
     * Adds an account to a live round as `pending` and extends the heartbeat. Used when a single-
     * account sync hits a running round that lacks the account or already settled it, so its result
     * lands in the same round. A non-live round -> none, and the caller opens a new one.
     * Re-enlisting a pending account at worst enqueues a message the consumer skips.
     */
    enlist: (input: EnlistSyncRoundInput): Effect.Effect<Option.Option<SyncRoundRecord>> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const path = sql`'$.accounts.' || json_quote(${input.account.id})`;
        const rows = yield* client.query((db) =>
          db
            .update(userCache)
            .set({
              v: sql`json_set(${userCache.v}, ${path}, json_object('label', ${input.account.label}, 'status', 'pending'))`,
              expiresAt: now + input.ttlMs,
            })
            .where(
              and(
                mine(input.portfolioId),
                sameRound(input.roundId),
                sql`json_extract(${asJson}, '$.finishedAt') is null`,
                sql`${userCache.expiresAt} > ${now}`,
              ),
            )
            .returning({ v: userCache.v, expiresAt: userCache.expiresAt }),
        );
        return Option.fromNullable(rows[0] ? decode(rows[0]) : undefined);
      }),

    /**
     * Heartbeat only: rounds queued behind the concurrency gate get no settles, so they need a
     * keepalive. Finished rounds aren't extended, so a late touch can't undo the retention.
     */
    touch: (input: TouchSyncRoundInput): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        yield* client.query((db) =>
          db
            .update(userCache)
            .set({ expiresAt: now + input.ttlMs })
            .where(
              and(
                mine(input.portfolioId),
                sameRound(input.roundId),
                sql`json_extract(${asJson}, '$.finishedAt') is null`,
              ),
            ),
        );
      }),

    finish: (input: FinishSyncRoundInput): Effect.Effect<void> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const next =
          input.error === undefined
            ? sql`json_set(${userCache.v}, '$.finishedAt', ${now})`
            : sql`json_set(${userCache.v}, '$.finishedAt', ${now}, '$.error', ${input.error})`;
        yield* client.query((db) =>
          db
            .update(userCache)
            .set({ v: next, expiresAt: now + input.retentionMs })
            .where(and(mine(input.portfolioId), sameRound(input.roundId))),
        );
      }),

    /**
     * Last one to settle finishes the round (one queue message per account, no single task runs it
     * end to end). One conditional UPDATE: of two concurrent callers only one wins, and the last
     * settler always sees zero pending. Read-then-write would lose both guarantees.
     * Returns the finished round to the winner, none otherwise.
     */
    finishIfSettled: (input: FinishSyncRoundInput): Effect.Effect<Option.Option<SyncRoundRecord>> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const rows = yield* client.query((db) =>
          db
            .update(userCache)
            .set({
              v:
                input.error === undefined
                  ? sql`json_set(${userCache.v}, '$.finishedAt', ${now})`
                  : sql`json_set(${userCache.v}, '$.finishedAt', ${now}, '$.error', ${input.error})`,
              expiresAt: now + input.retentionMs,
            })
            .where(
              and(
                mine(input.portfolioId),
                sameRound(input.roundId),
                sql`json_extract(${asJson}, '$.finishedAt') is null`,
                sql`not exists (select 1 from json_each(${asJson}, '$.accounts') where json_extract(value, '$.status') = 'pending')`,
              ),
            )
            .returning({ v: userCache.v, expiresAt: userCache.expiresAt }),
        );
        return Option.fromNullable(rows[0] ? decode(rows[0]) : undefined);
      }),
  };
};

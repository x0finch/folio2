import { Either, ParseResult, Schema } from "effect";
import { DAILY_PRICES_IDS_PER_MESSAGE, PRICES_IDS_PER_MESSAGE } from "./constants";

// Bodies carry only ids, never data: data is read at run time and may change while queued.
// Every body is schema-decoded first: delivery spans deploys, so an old-shaped message can reach a
// new consumer. Undecodable → ack + log, never retried.

/** Sync one account and record it in its round. */
export const SyncAccountJob = Schema.Struct({
  kind: Schema.Literal("sync-account"),
  userId: Schema.NonEmptyString,
  /** Round key (`sync-round:<portfolioId>`). */
  portfolioId: Schema.NonEmptyString,
  /** If the key now holds another round, this message is stale and skipped. */
  roundId: Schema.NonEmptyString,
  accountId: Schema.NonEmptyString,
});
export type SyncAccountJob = typeof SyncAccountJob.Type;

// Reference jobs, one message each so each gets its own CPU / subrequest budget. All are per-user
// (they write `user_cache` or the user's snapshots) and idempotent: TTL-gated or overwrite writes.
const userJob = <K extends string>(kind: K) =>
  Schema.Struct({ kind: Schema.Literal(kind), userId: Schema.NonEmptyString });

/** All fx rates in one call; no upstream inside the 6h TTL. */
const FxJob = userJob("fx");
/** Chains seen in the latest snapshot; fetches the chain list only when missing or stale. */
const PlatformsJob = userJob("platforms");
/** Top-N token catalogue; one-week TTL, so most runs make no upstream calls. */
const CatalogueJob = userJob("catalogue");
/** DeFi protocol logos gathered from the latest snapshot. No upstream. */
const DefiLogosJob = userJob("defi-logos");
/** Prune display notes past retention. No upstream. */
const PruneNotesJob = userJob("prune-notes");

export type ReferenceJob =
  | typeof FxJob.Type
  | typeof PlatformsJob.Type
  | typeof CatalogueJob.Type
  | typeof DefiLogosJob.Type;
export type PruneNotesJob = typeof PruneNotesJob.Type;

/**
 * Refresh a user's held-token prices. Without `tokenIds` it plans: computes ids at run time,
 * refreshes the first chunk and enqueues the rest. `maxItems` enforces the budget at decode time.
 */
export const PricesJob = Schema.Struct({
  kind: Schema.Literal("prices"),
  userId: Schema.NonEmptyString,
  tokenIds: Schema.optional(
    Schema.Array(Schema.NonEmptyString).pipe(Schema.maxItems(PRICES_IDS_PER_MESSAGE)),
  ),
});
export type PricesJob = typeof PricesJob.Type;

/**
 * Backfill daily prices / fx for manual accounts. Without `tokenIds`: all charted tokens; with
 * them: a targeted refill or a follow-up after the budget ran out. The budget is counted in calls
 * by the consumer, so `maxItems` only caps the body.
 */
export const DailyPricesJob = Schema.Struct({
  kind: Schema.Literal("daily-prices"),
  userId: Schema.NonEmptyString,
  tokenIds: Schema.optional(
    Schema.Array(Schema.NonEmptyString).pipe(Schema.maxItems(DAILY_PRICES_IDS_PER_MESSAGE)),
  ),
});
export type DailyPricesJob = typeof DailyPricesJob.Type;

export const Job = Schema.Union(
  SyncAccountJob,
  PricesJob,
  DailyPricesJob,
  FxJob,
  PlatformsJob,
  CatalogueJob,
  DefiLogosJob,
  PruneNotesJob,
);
export type Job = typeof Job.Type;

/** Errors carry paths and expectations only, never values: bodies hold ids we must not log. */
export const decodeJob = (body: unknown): Either.Either<Job, string> =>
  Either.mapLeft(Schema.decodeUnknownEither(Job)(body), (error) =>
    ParseResult.ArrayFormatter.formatErrorSync(error)
      .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue._tag}`)
      .join("; "),
  );

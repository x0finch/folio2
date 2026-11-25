import type { Note } from "@folio/connectors-basic";
import { isRetryable, type UpstreamError } from "@folio/upstream-basic";
import { Effect, Result } from "effect";

// Verdict for CEX accounts fetched as several isolated buckets, by failure kind (not count):
// - any transient failure (rate limit / timeout / 5xx) → fail the whole fetch and let sync retry;
//   a partial snapshot would overwrite real holdings that the next round would fetch fine.
// - only permanent failures (missing permission / changed shape) → degrade: keep what succeeded
//   and return the failed buckets so the caller can name them in a note.
// - everything failed → fail, so an empty snapshot never wipes the account.
export const bestEffortVerdict = <
  T extends { readonly result: Result.Result<A, UpstreamError> },
  A,
>(
  outcomes: readonly T[],
): Result.Result<readonly T[], UpstreamError> => {
  const failed = outcomes.filter((o) => Result.isFailure(o.result));

  // Prefer a rate-limit error among transient ones: its Retry-After is what sync's backoff uses.
  const transient =
    failed.find(
      (o) => Result.isFailure(o.result) && o.result.failure._tag === "UpstreamRateLimitError",
    ) ?? failed.find((o) => Result.isFailure(o.result) && isRetryable(o.result.failure));
  if (transient && Result.isFailure(transient.result)) return Result.fail(transient.result.failure);

  const first = failed[0];
  if (
    outcomes.length > 0 &&
    failed.length === outcomes.length &&
    first &&
    Result.isFailure(first.result)
  ) {
    return Result.fail(first.result.failure);
  }

  return Result.succeed(failed);
};

export interface FailedBucket {
  readonly name: string;
  readonly auth: boolean; // a missing permission, as opposed to a changed response shape
}

// biome-ignore lint/suspicious/noExplicitAny: buckets may need any services; the result keeps them
type Buckets = Readonly<Record<string, Effect.Effect<unknown, UpstreamError, any>>>;

export interface FetchedBuckets<B extends Buckets> {
  // Failed buckets are absent here and named in `failed`.
  readonly ok: { readonly [K in keyof B]?: Effect.Success<B[K]> };
  readonly failed: readonly FailedBucket[];
}

// Runs an account's buckets concurrently, keyed by the name a failure note shows, and applies
// `bestEffortVerdict`.
export const fetchBuckets = <const B extends Buckets>(
  buckets: B,
): Effect.Effect<FetchedBuckets<B>, UpstreamError, Effect.Services<B[keyof B]>> =>
  Effect.all(
    Object.entries(buckets).map(([name, bucket]) =>
      Effect.result(bucket).pipe(Effect.map((result) => ({ name, result }))),
    ),
    { concurrency: "unbounded" },
  ).pipe(
    Effect.flatMap((outcomes) =>
      Effect.fromResult(bestEffortVerdict(outcomes)).pipe(
        Effect.map((failed) => ({
          ok: Object.fromEntries(
            outcomes.flatMap((o) =>
              Result.isSuccess(o.result) ? [[o.name, o.result.success]] : [],
            ),
          ) as FetchedBuckets<B>["ok"],
          failed: failed.map((o) => ({
            name: o.name,
            auth: Result.isFailure(o.result) && o.result.failure._tag === "UpstreamAuthError",
          })),
        })),
      ),
    ),
  );

// Only reached for permanent failures (transient ones already failed the account).
export const failedBucketsNote = (
  title: string,
  failed: readonly FailedBucket[],
): Note | undefined => {
  if (failed.length === 0) return undefined;
  const names = failed.map((f) => f.name).join(" / ");
  const tail = failed.some((f) => f.auth)
    ? "check the API key's permissions"
    : "couldn't be read this round";
  return { title, icon: "warning", content: `${names} — ${tail}` };
};

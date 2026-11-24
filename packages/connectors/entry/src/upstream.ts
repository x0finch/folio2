import { isRetryable, type UpstreamError } from "@folio/upstream-basic";
import { Result } from "effect";

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

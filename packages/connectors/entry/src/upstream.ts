import type { UpstreamError } from "@folio/client-core";
import {
  ConnectorAuthError,
  type ConnectorError,
  ConnectorFailure,
  ConnectorRateLimitError,
  ConnectorUnavailableError,
  isRetryable,
} from "@folio/connectors-basic";
import { Effect, Match, Result } from "effect";

// One-to-one: client errors and connector errors are split by the same caller needs. Lives here,
// not in connectors-basic, because a value import of `@folio/client-core` there would pull the
// HTTP layer into the client bundle. Exported for adapters that inspect `status` first (bitcoin).
export const fromUpstreamError: (error: UpstreamError) => ConnectorError =
  Match.type<UpstreamError>().pipe(
    Match.tag(
      "UpstreamAuthError",
      (e) => new ConnectorAuthError({ message: describe(e), cause: e }) as ConnectorError,
    ),
    Match.tag(
      "UpstreamRateLimitError",
      (e) =>
        new ConnectorRateLimitError({
          message: describe(e),
          retryAfterMs: e.retryAfterMs,
          cause: e,
        }) as ConnectorError,
    ),
    Match.tag(
      "UpstreamUnavailableError",
      (e) => new ConnectorUnavailableError({ message: describe(e), cause: e }) as ConnectorError,
    ),
    // A changed response shape won't fix itself on retry.
    Match.tag(
      "UpstreamParseError",
      (e) => new ConnectorFailure({ message: describe(e), cause: e }) as ConnectorError,
    ),
    Match.exhaustive,
  );

// Only upstream / where / status: `where` is pathname-only by convention, while queries carry
// signatures and addresses. Never stringify `cause`; it's the raw upstream response.
const describe = (e: UpstreamError): string =>
  `${e.upstream} ${e._tag.replace("Upstream", "").replace("Error", "").toLowerCase()}` +
  ` at ${e.where}${e.status === undefined ? "" : ` (${e.status})`}`;

export const asConnector = <A, R>(
  effect: Effect.Effect<A, UpstreamError, R>,
): Effect.Effect<A, ConnectorError, R> => Effect.mapError(effect, fromUpstreamError);

// Verdict for CEX accounts fetched as several isolated buckets, by failure kind (not count):
// - any transient failure (rate limit / timeout / 5xx) → fail the whole fetch and let sync retry;
//   a partial snapshot would overwrite real holdings that the next round would fetch fine.
// - only permanent failures (missing permission / changed shape) → degrade: keep what succeeded
//   and return the failed buckets so the caller can name them in a note.
// - everything failed → fail, so an empty snapshot never wipes the account.
export const bestEffortVerdict = <
  T extends { readonly result: Result.Result<A, ConnectorError> },
  A,
>(
  outcomes: readonly T[],
): Result.Result<readonly T[], ConnectorError> => {
  const failed = outcomes.filter((o) => Result.isFailure(o.result));

  // Prefer a rate-limit error among transient ones: its Retry-After is what sync's backoff uses.
  const transient =
    failed.find(
      (o) => Result.isFailure(o.result) && o.result.failure._tag === "ConnectorRateLimitError",
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

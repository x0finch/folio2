import { Data, Match } from "effect";
import { ProviderError } from "./errors";

// Split by what callers need to tell apart (retry or not, how long, "fix your creds"), not by
// every way an upstream can fail. A `_tag` rather than a `retryable` flag, so `catchTag` is
// exhaustive and there is no field to forget.

interface Common {
  readonly message: string;
  readonly cause?: unknown;
}

// Retrying won't help; the credentials must change. `validateAccount` maps this to `false`.
export class ConnectorAuthError extends Data.TaggedError("ConnectorAuthError")<Common> {}

// `retryAfterMs` is the upstream's hint; retries prefer it.
export class ConnectorRateLimitError extends Data.TaggedError("ConnectorRateLimitError")<
  Common & { readonly retryAfterMs?: number }
> {}

export class ConnectorUnavailableError extends Data.TaggedError(
  "ConnectorUnavailableError",
)<Common> {}

// Unparseable response, unsupported operation, or unexpected throw: callers treat all of these
// the same (don't retry, mark the account failed), so they share a tag.
export class ConnectorFailure extends Data.TaggedError("ConnectorFailure")<Common> {}

export type ConnectorError =
  | ConnectorAuthError
  | ConnectorRateLimitError
  | ConnectorUnavailableError
  | ConnectorFailure;

// Shared by sync backoff and the add-account probe, which must agree. `Match.exhaustive` makes a
// new tag a compile error here instead of silently falling into a default.
export const isRetryable: (error: ConnectorError) => boolean = Match.type<ConnectorError>().pipe(
  Match.tag("ConnectorRateLimitError", "ConnectorUnavailableError", () => true),
  Match.tag("ConnectorAuthError", "ConnectorFailure", () => false),
  Match.exhaustive,
);

export const retryAfterOf = (error: ConnectorError): number | undefined =>
  error._tag === "ConnectorRateLimitError" ? error.retryAfterMs : undefined;

// Bridge for providers still throwing `ProviderError`. Matches by `instanceof`, not duck typing,
// so stray objects with `retryable: true` aren't retried; anything else is a non-retryable failure.
export function fromProviderError(err: unknown): ConnectorError {
  if (!(err instanceof ProviderError)) {
    return new ConnectorFailure({ message: messageOf(err), cause: err });
  }
  const fields = { message: err.message, cause: err };
  switch (err.code) {
    case "AUTH_FAILED":
    case "INVALID_CREDENTIALS":
      return new ConnectorAuthError(fields);
    case "RATE_LIMITED":
      return demoteIfNotRetryable(
        err,
        new ConnectorRateLimitError({ ...fields, retryAfterMs: err.retryAfterMs }),
        fields,
      );
    case "UPSTREAM_ERROR":
      return demoteIfNotRetryable(err, new ConnectorUnavailableError(fields), fields);
    default:
      return new ConnectorFailure(fields);
  }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// `ProviderError` lets `retryable` disagree with `code` (e.g. blockbook marks a 400 on a bad xpub as
// UPSTREAM_ERROR + retryable: false). Only demote the two retryable classes; auth errors must stay
// auth errors for `validateAccount`.
function demoteIfNotRetryable(
  err: ProviderError,
  classified: ConnectorError,
  fields: { readonly message: string; readonly cause: unknown },
): ConnectorError {
  return err.retryable === false ? new ConnectorFailure(fields) : classified;
}

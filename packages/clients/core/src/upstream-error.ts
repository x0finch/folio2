import { Data, Match } from "effect";
import type { HttpFailure, SigningFailure } from "./errors";

interface Common {
  readonly upstream: string; // "binance" / "okx" / …
  readonly where: string; // pathname only; the query may hold secrets
  readonly status?: number;
  // A summary string, never an error object: library errors carry signatures and API keys.
  readonly cause?: string;
}

// Bad credentials: retrying won't help.
export class UpstreamAuthError extends Data.TaggedError("UpstreamAuthError")<Common> {}

// Rate limited; `retryAfterMs` is the upstream's hint.
export class UpstreamRateLimitError extends Data.TaggedError("UpstreamRateLimitError")<
  Common & { readonly retryAfterMs?: number }
> {}

// Unreachable or 5xx: retryable.
export class UpstreamUnavailableError extends Data.TaggedError(
  "UpstreamUnavailableError",
)<Common> {}

// Response shape changed: not retryable.
export class UpstreamParseError extends Data.TaggedError("UpstreamParseError")<Common> {}

export type UpstreamError =
  | UpstreamAuthError
  | UpstreamRateLimitError
  | UpstreamUnavailableError
  | UpstreamParseError;

// For raw client errors; `@folio/connectors-basic` has the counterpart for `ConnectorError`.
export const isRetryable: (error: UpstreamError) => boolean = Match.type<UpstreamError>().pipe(
  Match.tag("UpstreamRateLimitError", "UpstreamUnavailableError", () => true),
  Match.tag("UpstreamAuthError", "UpstreamParseError", () => false),
  Match.exhaustive,
);

export const retryAfterOf = (error: UpstreamError): number | undefined =>
  error._tag === "UpstreamRateLimitError" ? error.retryAfterMs : undefined;

export interface ClassifyOptions {
  readonly upstream: string;
}

// Upstream-specific reclassification (e.g. binance's 400 = rejected signature) happens at the
// client's exit via `catchTag`, not here.
export const classifyFailure =
  (options: ClassifyOptions) =>
  (failure: HttpFailure | SigningFailure): UpstreamError => {
    const { upstream } = options;
    // Signing failed: not a transport fault (as one it would burn retries and hide the cause).
    // `_tag` rather than `instanceof`, which would depend on a single module instance.
    if (failure._tag === "SigningFailure") {
      return new UpstreamAuthError({ upstream, where: failure.where, cause: failure.cause });
    }

    const { where, status, retryAfterMs, cause } = failure;
    const base = { upstream, where, status, cause };
    return Match.value(failure.kind).pipe(
      Match.when("auth", () => new UpstreamAuthError(base)),
      Match.when(
        "rate-limited",
        () => new UpstreamRateLimitError({ upstream, where, status, retryAfterMs }),
      ),
      Match.when("parse", () => new UpstreamParseError(base)),
      Match.whenOr("network", "upstream", () => new UpstreamUnavailableError(base)),
      Match.exhaustive,
    );
  };

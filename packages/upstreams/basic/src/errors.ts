import { Match, Schema } from "effect";

// Six tiers, split by what a consumer does next: fix creds, wait, give up on this egress, retry,
// fix the input, or fix our parser. Only rate-limited and unavailable are worth retrying.

const Common = {
  upstream: Schema.String, // "binance" / "coinstats" / …
  where: Schema.String, // pathname only; the query may hold addresses and signatures
  status: Schema.optional(Schema.Number),
  // A summary string, never an error object: library errors carry signatures and API keys.
  cause: Schema.optional(Schema.String),
};

const TIER = {
  UpstreamAuthError: "auth",
  UpstreamRateLimitError: "rate-limited",
  UpstreamBlockedError: "blocked",
  UpstreamUnavailableError: "unavailable",
  UpstreamRefusedError: "refused",
  UpstreamParseError: "parse",
} as const;

export type UpstreamTier = (typeof TIER)[keyof typeof TIER];

export const tierOf = (error: UpstreamError): UpstreamTier => TIER[error._tag];

// Never includes `cause`: messages end up in logs and in front of the user.
const describe = (e: UpstreamError): string =>
  `${e.upstream} ${tierOf(e)} at ${e.where}${e.status === undefined ? "" : ` (${e.status})`}`;

// Credentials missing, rejected or unusable (incl. a failed signature).
export class UpstreamAuthError extends Schema.TaggedError<UpstreamAuthError>()(
  "UpstreamAuthError",
  Common,
) {
  override get message(): string {
    return describe(this);
  }
}

// `retryAfterMs` is the upstream's hint; retries prefer it.
export class UpstreamRateLimitError extends Schema.TaggedError<UpstreamRateLimitError>()(
  "UpstreamRateLimitError",
  { ...Common, retryAfterMs: Schema.optional(Schema.Number) },
) {
  override get message(): string {
    return describe(this);
  }
}

// The upstream refuses our egress (geo-block): retrying from the same place won't help; a base
// override might.
export class UpstreamBlockedError extends Schema.TaggedError<UpstreamBlockedError>()(
  "UpstreamBlockedError",
  Common,
) {
  override get message(): string {
    return describe(this);
  }
}

// Network failure, timeout or 5xx.
export class UpstreamUnavailableError extends Schema.TaggedError<UpstreamUnavailableError>()(
  "UpstreamUnavailableError",
  Common,
) {
  override get message(): string {
    return describe(this);
  }
}

// The upstream rejected the request itself (4xx, e.g. an invalid xpub): every retry gets the same.
export class UpstreamRefusedError extends Schema.TaggedError<UpstreamRefusedError>()(
  "UpstreamRefusedError",
  Common,
) {
  override get message(): string {
    return describe(this);
  }
}

// The response no longer has the shape we read.
export class UpstreamParseError extends Schema.TaggedError<UpstreamParseError>()(
  "UpstreamParseError",
  Common,
) {
  override get message(): string {
    return describe(this);
  }
}

export type UpstreamError =
  | UpstreamAuthError
  | UpstreamRateLimitError
  | UpstreamBlockedError
  | UpstreamUnavailableError
  | UpstreamRefusedError
  | UpstreamParseError;

// Shared by sync backoff and the add-account probe, which must agree; `Match.exhaustive` makes a
// new tier a compile error here.
export const isRetryable: (error: UpstreamError) => boolean = Match.type<UpstreamError>().pipe(
  Match.tag("UpstreamRateLimitError", "UpstreamUnavailableError", () => true),
  Match.tag(
    "UpstreamAuthError",
    "UpstreamBlockedError",
    "UpstreamRefusedError",
    "UpstreamParseError",
    () => false,
  ),
  Match.exhaustive,
);

export const retryAfterOf = (error: UpstreamError): number | undefined =>
  error._tag === "UpstreamRateLimitError" ? error.retryAfterMs : undefined;

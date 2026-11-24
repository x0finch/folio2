import { Data } from "effect";

// Intermediate classification of an outbound failure; clients only ever see `UpstreamError`.
export type HttpFailureKind =
  | "network" // never left (DNS / offline / fetch threw)
  | "rate-limited" // 429 by default; binance also uses 418
  | "auth" // 401 / 403
  | "blocked" // 451: the upstream refuses this egress region
  | "refused" // any other 4xx: the request itself is wrong
  | "upstream" // 5xx, 408
  | "parse"; // body isn't valid JSON or fails the schema

export class HttpFailure extends Data.TaggedError("HttpFailure")<{
  readonly kind: HttpFailureKind;
  // Pathname only: the query holds addresses and signatures, and this ends up in logs.
  readonly where: string;
  readonly status?: number;
  readonly retryAfterMs?: number; // from Retry-After (seconds or HTTP-date)
  // A summary string, typed so that passing the platform error (full request, signature and API
  // key included) won't compile.
  readonly cause?: string;
}> {}

// Signing failed. Not a transport fault: as one it would burn retries and hide the real cause.
export class SigningFailure extends Data.TaggedError("SigningFailure")<{
  readonly where: string;
  readonly cause?: string; // summary only; never the signer's thrown object
}> {}

// Message only: thrown objects can carry anything (platform HTTP errors carry the full request).
export const summaryOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : String(cause);

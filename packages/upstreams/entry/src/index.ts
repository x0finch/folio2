// Shared Effect transport for upstream clients (rate-limit → send → classify into the
// `@folio/upstream-basic` tiers). Retry policy lives in `@folio/sync`, around a whole fetch incl. its
// timeout; retrying here too would multiply attempts.

export { coinstatsBalance } from "./balance/coinstats/upstream";
export { hmacSha256 } from "./runtime/crypto";
export { HttpFailure, type HttpFailureKind, SigningFailure, summaryOf } from "./runtime/errors";
export {
  type HttpConfig,
  makeRequester,
  type Outbound,
  type Requester,
  type RequestOptions,
} from "./runtime/http";
export { FolioHttpClient } from "./runtime/http-client";
export {
  make as makeRateLimit,
  type RateLimitOptions,
  type RateLimitScope,
  RateLimitScopeOverride,
} from "./runtime/ratelimit";
export { maybe } from "./runtime/schema";
export { SLOT_URL_PREFIX, type SlotCache, SlotCacheOverride } from "./runtime/slot-cursor";
export {
  type StaleTolerantCache,
  type StaleTolerantCacheOptions,
  staleTolerantCache,
} from "./runtime/stale-cache";

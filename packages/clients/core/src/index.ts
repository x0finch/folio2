// Shared Effect transport for upstream clients (rate-limit → send → classify into the
// `@folio/upstream-basic` tiers). Retry policy lives in `@folio/sync`, around a whole fetch incl. its
// timeout; retrying here too would multiply attempts.

export { hmacSha256 } from "./crypto";
export { HttpFailure, type HttpFailureKind, SigningFailure, summaryOf } from "./errors";
export {
  type HttpConfig,
  makeRequester,
  type Outbound,
  type Requester,
  type RequestOptions,
} from "./http";
export { FolioHttpClient } from "./http-client";
export {
  make as makeRateLimit,
  type RateLimitOptions,
  type RateLimitScope,
  RateLimitScopeOverride,
} from "./ratelimit";
export { maybe } from "./schema";
export { SLOT_URL_PREFIX, type SlotCache, SlotCacheOverride } from "./slot-cursor";
export {
  type StaleTolerantCache,
  type StaleTolerantCacheOptions,
  staleTolerantCache,
} from "./stale-cache";

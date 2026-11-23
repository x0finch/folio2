export const RETRY_MAX_ATTEMPTS = 3; // total attempts (1 + 2 retries)
export const RETRY_BASE_MS = 200; // backoff base and jitter ceiling
export const RETRY_MAX_MS = 5000; // per-wait cap (Retry-After is clamped to it)
export const SYNC_CONCURRENCY = 6; // per-user account fetch concurrency; headroom for CF subrequests / provider limits
export const FETCH_TIMEOUT_MS = 20_000; // timeout for a single fetch attempt

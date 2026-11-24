// CoinStats OpenAPI constants. Only what the request layer needs: the env-var / creds-key identity of `COINSTATS_API_KEY` belongs to the adapter;
// the client takes the key's value and keeps only its identity as the rate-limit key.

// Who this is: goes into every error's `upstream` field.
export const UPSTREAM = "coinstats";

export const COINSTATS_API_BASE = "https://openapiv1.coinstats.app";
export const BALANCE_PATH = "/wallet/balance";
// Endpoint that needs only the API key, no address: verifies the key itself.
export const BLOCKCHAINS_PATH = "/wallet/blockchains";
export const API_KEY_HEADER = "X-API-KEY";

// Rate gate
// Needed here: one key serves three chains (sui / cosmos / solana) and sync runs 6 accounts concurrently, so one user's three chain accounts
// contend for one key's quota; a 429 swallowed by sync as ok:false shows only as that account not refreshing.
// The free tier's documented limit is 2 requests/s (plus a monthly credit quota; a multi-chain call costs more than one chain).
// Source: https://coinstats.app/api/ and https://openapi.coinstats.app/ (free tier 2 rps / 20k credits per month)
// Rate 1.6/s (80% of nominal, headroom since a 429 also counts as a request), capacity 2 (the burst the nominal limit allows): three chains together
// finish in ~2.5s, faster than a backoff round after hitting 429.
export const RATE_LIMIT_PER_SEC = 1.6;
export const RATE_LIMIT_BURST = 2;

// Gate key: the key's name, not its value (a value would go into logs, Map keys and cached URLs; see client-core `RateLimitOptions.key`).
// Clients built per chain share one queue, since they spend the same key's quota.
export const RATE_LIMIT_KEY = "coinstats:api-key";

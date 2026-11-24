// Zerion API constants. Only what the request layer needs: the address regex, debt position types and the `ZERION_API_KEY` env name belong to the adapter (the client takes the key's value).

// Who this is: goes into every error's `upstream` field.
export const UPSTREAM = "zerion";

export const ZERION_API_BASE = "https://api.zerion.io";
// All positions (tokens + DeFi, across all EVM chains in one response).
export const positionsPath = (address: string) => `/v1/wallets/${address}/positions/`;
// Light aggregate (liveness probe, far smaller than positions).
export const portfolioPath = (address: string) => `/v1/wallets/${address}/portfolio`;
// Chain list: authoritative source of slug to external_id (hex chainId); near-static.
export const CHAINS_PATH = "/v1/chains/";
export const CHAINS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// Filters out junk tokens, prices in USD and does not filter position types: this endpoint defaults to filter[positions]=only_simple,
// which returns only wallet spot and drops all DeFi positions, so without an explicit no_filter defi is always empty
// (measured on one address: default 101 rows, 0 defi; no_filter 188 rows, 87 defi).
export const POSITIONS_QUERY = {
  "filter[trash]": "only_non_trash",
  currency: "usd",
  "filter[positions]": "no_filter",
} as const;

// Rate gate
// Needed here: one fetch sends 2 requests in parallel and sync runs 6 accounts concurrently, so 12 requests hit one key at once
// (ZERION_API_KEY is shared across the deployment), over the free developer tier's documented 10 RPS (60k/month).
// Capacity 8 at 8/s: the common case (6 accounts, 12 requests) sends 8 at once and staggers the other 4 by 125ms (~0.5s total);
// bursts are spread below 8/s. 20% headroom because a 429 also counts as a request.
// Source: https://zerion.io/blog/top-questions-about-zerion-api/ (developer tier 10 RPS / 60k per month)
export const RATE_LIMIT_PER_SEC = 8;
export const RATE_LIMIT_BURST = 8;

// Gate key: the key's name, not its value (see `RateLimitOptions.key` in `@folio/upstreams`); one global key, so all accounts share this queue.
export const RATE_LIMIT_KEY = "zerion:api-key";

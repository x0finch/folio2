export const ID = "zerion";
export const ZERION_API_BASE = "https://api.zerion.io";
export const ZERION_API_KEY = "ZERION_API_KEY";

export const positionsPath = (address: string) => `/v1/wallets/${address}/positions/`;
// The light aggregate, for liveness probes.
export const portfolioPath = (address: string) => `/v1/wallets/${address}/portfolio`;
// The only source of slug → hex chainId; near-static.
export const CHAINS_PATH = "/v1/chains/";
export const CHAINS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// The default `filter[positions]=only_simple` drops every DeFi position (measured on one address:
// 101 rows and 0 defi by default, 188 and 87 with no_filter).
export const POSITIONS_QUERY = {
  "filter[trash]": "only_non_trash",
  currency: "usd",
  "filter[positions]": "no_filter",
} as const;

// One deployment key, 2 requests per fetch and 6 accounts at once: 12 requests against the
// developer tier's 10 RPS (https://zerion.io/blog/top-questions-about-zerion-api/). 8 at 8/s
// leaves headroom, since a 429 counts too; the common burst staggers by ~0.5 s in total.
export const RATE_LIMIT_PER_SEC = 8;
export const RATE_LIMIT_BURST = 8;

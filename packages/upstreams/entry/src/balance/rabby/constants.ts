export const ID = "rabby";
export const RABBY_API_BASE = "https://api.rabby.io";
// Unset in production; only local perf tests point it at a fake upstream.
export const RABBY_API_BASE_OVERRIDE = "RABBY_API_BASE";

export const CHAIN_LIST_PATH = "/v1/chain/list";
export const CACHE_TOKEN_LIST_PATH = "/v1/user/cache_token_list";
export const COMPLEX_PROTOCOL_LIST_PATH = "/v1/user/complex_protocol_list";
export const TOTAL_BALANCE_PATH = "/v1/user/total_balance"; // the lightest, for liveness probes
export const CHAINS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// Part of the signature computation; don't change.
export const RABBY_CLIENT = "Rabby";
export const RABBY_CLIENT_VERSION = "0.93.49";

// Rabby throttles instantaneous concurrency, not volume (measured: 150 serial signed requests all
// passed, 20 concurrent lost 5 and recovered slowly), and its 429 has no Retry-After. Sync runs ~12
// requests at once, right at the edge, so never hit it: one request at a time, 8/s. The quota
// follows the signature, not the egress IP, so the whole deployment shares one bucket.
export const MAX_REQUESTS_PER_SECOND = 8;

// Contract tokens below this USD value are dropped (native coins exempt); rabby has no server-side
// trash filter. Measured on one address: $1 halves the rows (907 → 444) losing $104 (0.01%).
export const DUST_USD = 1;

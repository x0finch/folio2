export const ID = "hyperliquid";
export const HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz";
// Unset in production; only local perf tests point it at a fake upstream.
export const HYPERLIQUID_API_BASE_OVERRIDE = "HYPERLIQUID_API_BASE";
// Every read-only query is a POST here, the question named by `type` in the body.
export const INFO_PATH = "/info";
export const CLEARINGHOUSE_TYPE = "clearinghouseState";

// No rate gate: the quota is per egress IP at 1200 weight/min and `clearinghouseState` weighs 2
// (https://hyperliquid.gitbook.io/hyperliquid-docs/for-developers/api/rate-limits-and-user-limits).
// One request per account at sync concurrency 6 never comes close; redo this if calls go per coin.

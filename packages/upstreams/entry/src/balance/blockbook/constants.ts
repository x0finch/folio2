export const ID = "blockbook";

// Public Trezor nodes; a rate-limited or failing one hands the request to the next (see api.ts).
export const BLOCKBOOK_BASES = [
  "https://btc2.trezor.io/api/v2",
  "https://btc3.trezor.io/api/v2",
  "https://btc4.trezor.io/api/v2",
  "https://btc5.trezor.io/api/v2",
] as const;
// Unset in production; pins one node (self-hosted, or a local fake for perf tests).
export const BLOCKBOOK_API_BASE_OVERRIDE = "BLOCKBOOK_API_BASE";

// Requests carry an xpub (a whole wallet's watch key), so the UA must not name the project and tie
// watchers to a person. It can't be omitted either: Workers send none and the nodes' WAF answers 403.
export const USER_AGENT = "Mozilla/5.0";

// Server-side derivation with per-address totals, used addresses only.
export const XPUB_DETAILS = "tokenBalances";
export const XPUB_TOKENS = "used";
// Account summary only, for the liveness probe.
export const XPUB_SUMMARY_DETAILS = "basic";

// No rate gate: four public nodes take turns, and the answer to a rate limit is switching node,
// not queueing; both together would multiply latency.

export const SATS_PER_BTC = 100_000_000;
export const EXT_PUBKEY_RE = /^(xpub|ypub|zpub)/;

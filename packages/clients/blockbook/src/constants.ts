// Trezor Blockbook v2 constants.

export const UPSTREAM = "blockbook";

// Several endpoints: a rate-limited or failing node moves on to the next (see client.ts rotation); no env config needed.
export const BLOCKBOOK_BASES = [
  "https://btc2.trezor.io/api/v2",
  "https://btc3.trezor.io/api/v2",
  "https://btc4.trezor.io/api/v2",
  "https://btc5.trezor.io/api/v2",
];

// Deliberately neutral: no project name, no repo address. These requests carry an xpub (the whole wallet's watch key) to a third party, and a
// UA naming the project would tie "who is watching this address" to a person and group self-hosted instances.
// It cannot simply be omitted: Workers' fetch sends no UA and these sites' WAFs answer 403, so use the most common unspecific value.
export const USER_AGENT = "Mozilla/5.0";

// Default query for the xpub endpoint: server-side derivation + totals, used addresses only.
export const DEFAULT_XPUB_DETAILS = "tokenBalances";
export const DEFAULT_XPUB_TOKENS = "used";
// Liveness tier: account summary only (see `XpubSummary`).
export const XPUB_SUMMARY_DETAILS = "basic";

// No rate gate here: four public nodes take turns and the answer to rate limiting is switching node, not queueing; both together would multiply latency.

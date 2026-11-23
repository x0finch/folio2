// Constants for the CoinGecko adapter; only this package knows them.

// Id this adapter reports; it is the tokenRef namer and the global ref-index `namer` column.
export const UPSTREAM_ID = "coingecko";

export const VS_USD = "usd";
// Per-entry timestamp field (seconds) of `/simple/price?include_last_updated_at=true`; carries no currency prefix.
export const LAST_UPDATED_AT = "last_updated_at";

// BTC's coin id: base of both legs of fiat history (derived from BTC), and the key of the BTC/USD leg in `token_daily_prices`.
export const BTC_COIN_ID = "bitcoin";
export const SEARCH_LIMIT = 20;
export const MARKETS_PER_PAGE = 250; // CoinGecko per-page cap

// Ids per GET: too many ids in the query string exceed the server's URI limit (HTTP 414), failing the whole batch.
// 100 long slugs (~4KB) stay under common 8KB limits and 100 <= MARKETS_PER_PAGE, so one page per batch.
export const IDS_PER_REQUEST = 100;

// Explicit non-EVM slug map: our namer to CoinGecko's asset_platform id. EVM needs none (aligned by chainId).
// Matching names are luck, not a rule; a mismatch silently drops that chain's prices, so `toRefIndexRows` reports unmatched ones.
export const NON_EVM_PLATFORMS: Readonly<Record<string, string>> = {
  solana: "solana",
  sui: "sui",
  cosmos: "cosmos",
};

// Curated symbol to coin id for majors and known collisions; wins over market-cap rank. Keys are normalised uppercase symbols.
export const OVERRIDES: Readonly<Record<string, string>> = {
  BTC: "bitcoin",
  ETH: "ethereum",
  USDT: "tether",
  USDC: "usd-coin",
  BNB: "binancecoin",
  SOL: "solana",
  XRP: "ripple",
  ADA: "cardano",
  DOGE: "dogecoin",
  TRX: "tron",
  TON: "the-open-network",
  DAI: "dai",
  AVAX: "avalanche-2",
  SUI: "sui",
  ATOM: "cosmos",
};

// EVM namer prefix: the contract endpoint needs a slug derived from the numeric chainId.
export const EVM_NAMER_PREFIX = "evm:";

// Retry: the client has no retry of its own, so this adapter (the caller) owns the policy.
// One retry is enough: it only dodges transient blips; real quota exhaustion gives a long Retry-After and we give up (SWR serves stale).
export const RETRY_ATTEMPTS = 2; // total attempts (1 + 1 retry)
export const RETRY_BASE_MS = 250; // backoff base and jitter amplitude

// Max single wait: this path can sit on a user's write path and free-tier Retry-After can reach 60s, so over-limit waits give up
// instead of sleeping (`exceedsMaxWait: "throw"`, deliberately opposite to the background-sync clamp).
export const RETRY_MAX_WAIT_MS = 2000;

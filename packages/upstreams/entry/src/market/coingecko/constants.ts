// Also the tokenRef namer and the global ref-index `namer` column.
export const ID = "coingecko";

export const CG_BASE_FREE = "https://api.coingecko.com/api/v3";
export const CG_BASE_PRO = "https://pro-api.coingecko.com/api/v3";
export const CG_BASE_OVERRIDE = "COINGECKO_API_BASE";
// The key's kind decides the tier: base, header and quota.
export const COINGECKO_API_KEY = "COINGECKO_API_KEY"; // demo
export const COINGECKO_PRO_API_KEY = "COINGECKO_PRO_API_KEY";
export const PRO_HOST = "pro";
export const HEADER_DEMO = "x-cg-demo-api-key";
export const HEADER_PRO = "x-cg-pro-api-key";
// Deliberately neutral: a UA naming the project would tie "who is watching" to a person and group
// self-hosted instances. It cannot be omitted: Workers' fetch sends none and CGK's Cloudflare WAF
// answers 403.
export const USER_AGENT = "Mozilla/5.0";

// https://docs.coingecko.com/docs/common-errors-rate-limit: demo 100 calls/min; keyless is per
// egress IP with no number given; paid tiers vary. 4xx / 5xx count toward quota too.
export const CG_CALLS_PER_MIN_DEMO = 80; // 20% left for error responses and window edges
export const CG_CALLS_PER_MIN_KEYLESS = 10; // conservative, not measured; adjust on hitting it
export const CG_CALLS_PER_MIN_PRO = 400; // clearly conservative; tune to your own plan

// Burst 2, not 4: catalogue warm walks 4 pages while search and the picker fire on user input from
// the same bucket; a large burst lets warm drain it and stall the next search. Also why
// `fetchMarkets` stays sequential.
export const CG_BURST = 2;

export const VS_USD = "usd";
// Per-entry timestamp field (seconds) of `/simple/price?include_last_updated_at=true`; no currency prefix.
export const LAST_UPDATED_AT = "last_updated_at";

// Base of both legs of fiat history (derived from BTC), and the key of the BTC/USD leg in `token_daily_prices`.
export const BTC_COIN_ID = "bitcoin";
export const SEARCH_LIMIT = 20;
export const MARKETS_PER_PAGE = 250; // CoinGecko per-page cap

// Too many ids exceed the server's URI limit (HTTP 414), failing the whole batch. 100 long slugs
// (~4KB) stay under common 8KB limits, and 100 <= MARKETS_PER_PAGE keeps one page per batch.
export const IDS_PER_REQUEST = 100;

// Our namer to CoinGecko's asset_platform id; EVM needs none (aligned by chainId). Matching names are
// luck, not a rule; a mismatch silently drops that chain's prices, so `toRefIndexRows` reports unmatched ones.
export const NON_EVM_PLATFORMS: Readonly<Record<string, string>> = {
  solana: "solana",
  sui: "sui",
  cosmos: "cosmos",
};

// Symbol to coin id for majors and known collisions; wins over market-cap rank. Keys are normalised uppercase.
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

export const EVM_NAMER_PREFIX = "evm:";

// One retry only dodges transient blips; real quota exhaustion gives a long Retry-After and we give
// up (SWR serves stale).
export const RETRY_ATTEMPTS = 2; // total attempts
export const RETRY_BASE_MS = 250; // backoff base and jitter amplitude
// This path can sit on a user's write path and free-tier Retry-After can reach 60s, so a longer
// wait gives up instead of sleeping (opposite to the background-sync clamp).
export const RETRY_MAX_WAIT_MS = 2000;

export const EXCHANGE_RATES_PATH = "/exchange_rates";

// Also the issuer in `tokenRef.issued(...)`: changing it changes every binance token's identity.
export const ID = "binance";

// Binance 403s Cloudflare egress, so production sets all three overrides to a proxy. Values may
// embed a proxy key: never log them.
export const BINANCE_API_BASE = "https://api.binance.com";
export const BINANCE_API_BASE_OVERRIDE = "BINANCE_API_BASE";
export const BINANCE_FUTURES_API_BASE = "https://fapi.binance.com"; // USDⓈ-M
export const BINANCE_FUTURES_API_BASE_OVERRIDE = "BINANCE_FAPI_BASE";
export const BINANCE_DELIVERY_API_BASE = "https://dapi.binance.com"; // COIN-M
export const BINANCE_DELIVERY_API_BASE_OVERRIDE = "BINANCE_DAPI_BASE";
export const FUTURES_HOST = "fapi";
export const DELIVERY_HOST = "dapi";

export const ACCOUNT_PATH = "/api/v3/account"; // signed; a read-only key suffices
export const TICKER_PRICE_PATH = "/api/v3/ticker/price"; // public, whole market
export const USDM_ACCOUNT_PATH = "/fapi/v2/account"; // equity + positions in one call
export const COINM_ACCOUNT_PATH = "/dapi/v1/account"; // per-asset equity (in coin) + positions
export const FUNDING_ASSET_PATH = "/sapi/v1/asset/get-funding-asset"; // a signed POST
export const EARN_FLEXIBLE_PATH = "/sapi/v1/simple-earn/flexible/position";
export const EARN_LOCKED_PATH = "/sapi/v1/simple-earn/locked/position";
// The page size defaults to 10; the page cap guards against an upstream that never ends.
export const EARN_PAGE_SIZE = 100;
export const EARN_MAX_PAGES = 50;

export const API_KEY_HEADER = "X-MBX-APIKEY";
export const RECV_WINDOW = 5000; // ms

// The ticker quota is per egress IP (6000 weight/min) and the whole-market ticker weighs 200, so
// ~30/min. 24/min with a burst of 6 (sync's concurrency) keeps clear of it: repeated 429s
// escalate to 418, an IP ban of 2 minutes to 3 days.
// https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits
export const TICKER_LIMIT = "ticker";
export const TICKER_RATE_LIMIT_PER_MIN = 24;
export const TICKER_RATE_LIMIT_BURST = 6;
// 418 is the IP ban earned by ignoring 429; same handling.
export const RATE_LIMITED_STATUSES = [429, 418];
// A rejected signed request (bad secret -1022, malformed key -2014).
export const SIGNED_REQUEST_REJECTED_STATUS = 400;

// Valued at $1: they have no `${asset}USDT` pair.
export const STABLECOINS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "BUSD",
  "FDUSD",
  "TUSD",
  "DAI",
]);
export const QUOTE_ASSET = "USDT";
export const MARGIN_ASSET = "USDT";
// Stripped longest-first to avoid a partial match (BTCUSDT → BTC).
export const QUOTE_SUFFIXES: readonly string[] = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD"];

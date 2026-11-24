export const BINANCE_API_BASE = "https://api.binance.com";
export const ACCOUNT_PATH = "/api/v3/account"; // SIGNED, USER_DATA (a read-only key suffices)
export const TICKER_PRICE_PATH = "/api/v3/ticker/price"; // public, whole market
export const API_KEY_HEADER = "X-MBX-APIKEY";
export const RECV_WINDOW = 5000; // ms

// Quota is per IP (6000 weight/min); whole-market ticker weighs 200 → ~30/min.
// https://developers.binance.com/docs/binance-spot-api-docs/rest-api/limits
// 24/min (80% of nominal), burst 6 = SYNC_CONCURRENCY so a typical sync isn't delayed.
// Conservative because repeated 429s escalate to 418 (IP ban, 2 min to 3 days).
export const TICKER_RATE_LIMIT_PER_SEC = 24 / 60;
export const TICKER_RATE_LIMIT_BURST = 6;
// Provider-wide key: the quota is per egress IP, not per account.
export const PUBLIC_LIMIT_KEY = "binance:public";
// 418 is the IP ban earned by ignoring 429; same handling.
export const RATE_LIMITED_STATUSES = [429, 418] as const;

// USDⓈ-M futures live on a separate host.
export const BINANCE_FUTURES_API_BASE = "https://fapi.binance.com";
export const USDM_ACCOUNT_PATH = "/fapi/v2/account"; // SIGNED; equity + positions in one call

// COIN-M futures: another host; margin is in coin, not USDT.
export const BINANCE_DELIVERY_API_BASE = "https://dapi.binance.com";
export const COINM_ACCOUNT_PATH = "/dapi/v1/account"; // SIGNED; per-asset equity + positions

// Funding wallet: signed POST on the main host; amounts only, no USD.
export const FUNDING_ASSET_PATH = "/sapi/v1/asset/get-funding-asset";

// Simple Earn (signed GETs on the main host).
export const EARN_FLEXIBLE_PATH = "/sapi/v1/simple-earn/flexible/position";
export const EARN_LOCKED_PATH = "/sapi/v1/simple-earn/locked/position";
// Page size defaults to 10, max 100. EARN_MAX_PAGES guards against a never-ending upstream.
export const EARN_PAGE_SIZE = 100;
export const EARN_MAX_PAGES = 50;

// Binance's "signed request rejected"; see errors.ts.
export const SIGNED_REQUEST_REJECTED_STATUS = 400;

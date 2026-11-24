// Also the issuer in `tokenRef.issued(...)`.
export const ID = "bybit";
export const BYBIT_API_BASE = "https://api.bybit.com";
// A proxy for when Bybit refuses the Workers egress region; may embed a proxy key, never log it.
export const BYBIT_API_BASE_OVERRIDE = "BYBIT_API_BASE";

export const WALLET_BALANCE_PATH = "/v5/account/wallet-balance"; // unified account (UTA)
export const FUNDING_BALANCES_PATH = "/v5/asset/transfer/query-account-coins-balance";
export const EARN_POSITION_PATH = "/v5/earn/position";

export const ACCOUNT_TYPE_UNIFIED = "UNIFIED";
export const ACCOUNT_TYPE_FUND = "FUND";
export const EARN_CATEGORY_FLEXIBLE = "FlexibleSaving";
export const EARN_CATEGORY_ONCHAIN = "OnChain";

export const RECV_WINDOW = "5000";
export const HEADER_KEY = "X-BAPI-API-KEY";
export const HEADER_SIGN = "X-BAPI-SIGN";
export const HEADER_TIMESTAMP = "X-BAPI-TIMESTAMP";
export const HEADER_RECV_WINDOW = "X-BAPI-RECV-WINDOW";
export const HEADER_SIGN_TYPE = "X-BAPI-SIGN-TYPE";
export const SIGN_TYPE_HMAC = "2"; // HMAC-SHA256

// Errors arrive as HTTP 200 + a numeric `retCode` (0 = OK). These mean credentials, signature or
// permissions.
export const RET_CODE_OK = 0;
export const AUTH_ERROR_CODES: ReadonlySet<number> = new Set([
  10003, // API key is invalid
  10004, // sign check error
  10005, // permission denied for current apikey
  10010, // request ip mismatch
  33004, // apikey expired
]);

// Fallback $1 valuation for funding / earn rows, which carry no price of their own.
export const STABLECOINS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "DAI",
  "TUSD",
  "FDUSD",
  "USD1",
  "USDE",
  "USDD",
]);

// No rate gate: the quota follows each account's own key, and one fetch is a fixed four calls.

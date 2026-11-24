// Bybit v5 API constants. Only what the request layer needs: `STABLECOINS` (valuation / display) and the `BYBIT_API_BASE` env name belong
// to the adapter (the client takes the base's value).

export const BYBIT_API_BASE = "https://api.bybit.com";
export const WALLET_BALANCE_PATH = "/v5/account/wallet-balance"; // unified account (query accountType=UNIFIED)
export const FUNDING_BALANCES_PATH = "/v5/asset/transfer/query-account-coins-balance"; // funding account (accountType=FUND)
export const EARN_POSITION_PATH = "/v5/earn/position"; // earn positions (query category)

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
// Signature algorithm version, sent with the signature; "2" = HMAC-SHA256.
export const SIGN_TYPE_HMAC = "2";

// Bybit signals errors as HTTP 200 + retCode (a number, 0 = OK). These retCodes are credential / signature / permission problems.
export const AUTH_ERROR_CODES: ReadonlySet<number> = new Set([
  10003, // API key is invalid
  10004, // sign check error
  10005, // permission denied for current apikey
  10010, // request ip mismatch (unmatched IP)
  33004, // apikey expired
]);
export const RET_CODE_OK = 0;

// No rate gate: quota is per account's own key and one sync's endpoint count per account is a fixed few, not contending; a gate would
// block nothing and queue unrelated accounts.

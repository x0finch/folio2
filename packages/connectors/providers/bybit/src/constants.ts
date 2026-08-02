// Bybit API v5 常量(不硬编码散落,见原则 #8)。
export const BYBIT_API_BASE = "https://api.bybit.com";
export const WALLET_BALANCE_PATH = "/v5/account/wallet-balance"; // 统一账户(query accountType=UNIFIED)
export const FUNDING_BALANCES_PATH = "/v5/asset/transfer/query-account-coins-balance"; // 资金账户(accountType=FUND)

// 签名时效窗口(ms)—— 被签串与头都用它。Bybit 默认/建议 5000。
export const RECV_WINDOW = "5000";

export const HEADER_KEY = "X-BAPI-API-KEY";
export const HEADER_SIGN = "X-BAPI-SIGN";
export const HEADER_TIMESTAMP = "X-BAPI-TIMESTAMP";
export const HEADER_RECV_WINDOW = "X-BAPI-RECV-WINDOW";
export const HEADER_SIGN_TYPE = "X-BAPI-SIGN-TYPE";

// Bybit 以 HTTP 200 + retCode(**数字**,0=OK)表错误。这些 retCode = 凭据/签名/权限问题 → AUTH_FAILED。
export const AUTH_ERROR_CODES: ReadonlySet<number> = new Set([
  10003, // API key is invalid
  10004, // sign check error
  10005, // permission denied for current apikey
  10010, // request ip mismatch (unmatched IP)
  33004, // apikey expired
]);

// 稳定币按 1 美元估值兜底(资金/赚币无自带价、oracle 尚未回填时用)。含 USD1(World Liberty Financial
// USD)等新稳定币 —— 探测账户大头是 USD1。
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

// Bybit API v5 常量(不硬编码散落,见原则 #8)。
export const BYBIT_API_BASE = "https://api.bybit.com";
export const WALLET_BALANCE_PATH = "/v5/account/wallet-balance"; // 统一账户(query accountType=UNIFIED)

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

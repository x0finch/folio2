// Bybit v5 API 常量(不硬编码散落,见原则 #8)。
//
// **只有请求层要的那些在这里。** 老 provider 的 `STABLECOINS`(估值/展示用)属于适配层,不进 client。
// `BYBIT_API_BASE` 那个「env 变量名」的身份也归适配层 —— client 收 base 的**值**(ADR 0036 边界决定 2)。

export const BYBIT_API_BASE = "https://api.bybit.com";
export const WALLET_BALANCE_PATH = "/v5/account/wallet-balance"; // 统一账户(query accountType=UNIFIED)
export const FUNDING_BALANCES_PATH = "/v5/asset/transfer/query-account-coins-balance"; // 资金账户(accountType=FUND)
export const EARN_POSITION_PATH = "/v5/earn/position"; // 赚币持仓(query category)

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
// 签名算法版本,Bybit 要求跟着签名一起发。"2" = HMAC-SHA256。
export const SIGN_TYPE_HMAC = "2";

// Bybit 以 HTTP 200 + retCode(**数字**,0=OK)表错误。这些 retCode = 凭据/签名/权限问题。
export const AUTH_ERROR_CODES: ReadonlySet<number> = new Set([
  10003, // API key is invalid
  10004, // sign check error
  10005, // permission denied for current apikey
  10010, // request ip mismatch (unmatched IP)
  33004, // apikey expired
]);
export const RET_CODE_OK = 0;

// —— 为什么这里**没有**速率闸 ——
// 判据是「有没有多个调用挤同一份额度」。Bybit 的额度按**账户自己那把 key** 算,而一次同步
// 一个账户的端点数是固定的几发、不并挤;两个账户各花各的额度。装了拦不到任何东西,
// 还会把互不相干的账户排成一队白等。

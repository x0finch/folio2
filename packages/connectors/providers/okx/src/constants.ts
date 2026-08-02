// OKX API v5 常量(不硬编码散落,见原则 #8)。
export const OKX_API_BASE = "https://www.okx.com";
export const BALANCE_PATH = "/api/v5/account/balance"; // 交易账户(trading 桶)余额(自带 eqUsd)
export const FUNDING_BALANCES_PATH = "/api/v5/asset/balances"; // 资金账户(funding 桶)余额(数量取 bal)

// 稳定币按 1 美元估值兜底(交易账户没这个币、oracle 尚未回填时用)。与 binance 同口径。
export const STABLECOINS: ReadonlySet<string> = new Set(["USDT", "USDC", "DAI", "TUSD", "FDUSD"]);

export const HEADER_KEY = "OK-ACCESS-KEY";
export const HEADER_SIGN = "OK-ACCESS-SIGN";
export const HEADER_TIMESTAMP = "OK-ACCESS-TIMESTAMP";
export const HEADER_PASSPHRASE = "OK-ACCESS-PASSPHRASE";

// OKX 以 HTTP 200 + code 表错误。这些 code = 凭据/签名/时间戳/passphrase 问题 → AUTH_FAILED。
export const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "50100", // API frozen
  "50101", // broker domain mismatch
  "50102", // timestamp expired
  "50103", // missing header
  "50104", // missing passphrase
  "50105", // passphrase incorrect
  "50111", // invalid OK-ACCESS-KEY
  "50113", // invalid signature
]);

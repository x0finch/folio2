// OKX API v5 常量(不硬编码散落,见原则 #8)。
export const OKX_API_BASE = "https://www.okx.com";
export const BALANCE_PATH = "/api/v5/account/balance"; // 交易账户余额(自带 eqUsd)

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

// detail 块标签 —— app i18n key(前端 translate 解析,跟随中英双语;ADR 0010:标签用 i18n key,非写死文案)。
// 复用 apps/web 的 Overview 命名空间 CEX 键(cexBreakdown / cexAvailable / cexFrozen)。
export const DETAIL_LABEL = {
  breakdown: "Overview.cexBreakdown",
  available: "Overview.cexAvailable",
  frozen: "Overview.cexFrozen",
} as const;

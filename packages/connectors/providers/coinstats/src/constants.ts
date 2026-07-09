// CoinStats OpenAPI 常量(不硬编码散落,见原则 #8)。
export const COINSTATS_API_BASE = "https://openapiv1.coinstats.app";
export const BALANCE_PATH = "/wallet/balance";
// 只需 API key、不需地址的端点 —— 用来实测 provider key 本身是否有效(validateCreds)。
export const BLOCKCHAINS_PATH = "/wallet/blockchains";
// provider key 在 ctx.creds 里的键名(= app 注入的 env 变量名)+ 请求头名。
export const COINSTATS_API_KEY = "COINSTATS_API_KEY";
export const API_KEY_HEADER = "X-API-KEY";

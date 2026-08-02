// OKX API v5 常量(不硬编码散落,见原则 #8)。
export const OKX_API_BASE = "https://www.okx.com";
export const BALANCE_PATH = "/api/v5/account/balance"; // 交易账户(trading 桶)余额(自带 eqUsd)
export const FUNDING_BALANCES_PATH = "/api/v5/asset/balances"; // 资金账户(funding 桶)余额(数量取 bal)
export const SAVINGS_BALANCE_PATH = "/api/v5/finance/savings/balance"; // 赚币·活期出借(数量取 amt)
export const STAKING_ORDERS_ACTIVE_PATH = "/api/v5/finance/staking-defi/orders-active"; // 赚币·链上活跃订单
// 四桶权威估值(对账锚)。**必须带 `ccy=USD`** —— 该端点默认按 **BTC** 计价,不传就拿到 BTC 数值,
// 与美元口径的余额加总一比就单位错位、对账形同虚设(真机验证过)。OKX 签名覆盖含 query 的 requestPath,
// 故 query 直接拼进 path 串(见 index.ts fetchBalances,不走 http client 的 query 选项——那不进签名)。
export const ASSET_VALUATION_PATH = "/api/v5/asset/asset-valuation?ccy=USD";
export const POSITIONS_PATH = "/api/v5/account/positions"; // 合约持仓探测(perp 兜底 Note 用)

// 稳定币按 1 美元估值兜底(交易账户没这个币、oracle 尚未回填时用)。与 binance 同口径。
export const STABLECOINS: ReadonlySet<string> = new Set(["USDT", "USDC", "DAI", "TUSD", "FDUSD"]);

// earn 桶残差阈值:拉到的 earn 子项加总与 asset-valuation 的 earn 桶差额 > 此值才挂"未细分"account 级 Note。
export const EARN_RESIDUAL_MIN_USD = 1;

// 未细分赚币合成聚合行的 logo(OKX 品牌 X 形标,quincunx)。内嵌 data-URI:自包含、离线可用、
// 客户端零第三方 CDN(ADR 0008);走 tokenLogoUrl 的 data: 直挂分支,不经 /api/logo 代理。
export const OKX_EARN_LOGO =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzExMTMxOCIvPjxnIGZpbGw9IiNmZmYiPjxyZWN0IHg9IjQiIHk9IjQiIHdpZHRoPSI0LjYiIGhlaWdodD0iNC42Ii8+PHJlY3QgeD0iMTUuNCIgeT0iNCIgd2lkdGg9IjQuNiIgaGVpZ2h0PSI0LjYiLz48cmVjdCB4PSI5LjciIHk9IjkuNyIgd2lkdGg9IjQuNiIgaGVpZ2h0PSI0LjYiLz48cmVjdCB4PSI0IiB5PSIxNS40IiB3aWR0aD0iNC42IiBoZWlnaHQ9IjQuNiIvPjxyZWN0IHg9IjE1LjQiIHk9IjE1LjQiIHdpZHRoPSI0LjYiIGhlaWdodD0iNC42Ii8+PC9nPjwvc3ZnPg==";

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

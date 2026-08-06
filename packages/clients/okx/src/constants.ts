// OKX v5 API 常量(不硬编码散落,见原则 #8)。
//
// **只有请求层要的那些在这里。** 老 provider 的 `STABLECOINS` / `EARN_RESIDUAL_MIN_USD` /
// `OKX_EARN_LOGO`(估值与展示)属于适配层,不进 client。`OKX_API_BASE` 那个「env 变量名」的
// 身份也归适配层 —— client 收 base 的**值**(ADR 0036 边界决定 2)。

export const OKX_API_BASE = "https://www.okx.com";
export const BALANCE_PATH = "/api/v5/account/balance"; // 交易账户(自带 eqUsd)
export const FUNDING_BALANCES_PATH = "/api/v5/asset/balances"; // 资金账户(数量取 bal)
export const SAVINGS_BALANCE_PATH = "/api/v5/finance/savings/balance"; // 赚币·活期出借(数量取 amt)
export const STAKING_ORDERS_ACTIVE_PATH = "/api/v5/finance/staking-defi/orders-active"; // 赚币·链上活跃订单
export const ASSET_VALUATION_PATH = "/api/v5/asset/asset-valuation"; // 各桶权威美元(query ccy)
export const POSITIONS_PATH = "/api/v5/account/positions"; // 合约持仓

// asset-valuation 的计价币。老代码把 `?ccy=USD` 直接焊进路径常量里 —— 那样签名恰好也对
// (签的是含 query 的 requestPath),但 query 就绕过了 `makeRequester` 的拼装。这里拆开走 query,
// 由签名那一步重新拼回 requestPath(见 client.ts)。
export const VALUATION_CCY = "USD";

export const HEADER_KEY = "OK-ACCESS-KEY";
export const HEADER_SIGN = "OK-ACCESS-SIGN";
export const HEADER_TIMESTAMP = "OK-ACCESS-TIMESTAMP";
export const HEADER_PASSPHRASE = "OK-ACCESS-PASSPHRASE";

// OKX 以 HTTP 200 + code(**字符串**,"0"=OK)表错误 —— 异于 Bybit 的数字 retCode。
// 这些 code = 凭据/签名/权限问题。
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
export const CODE_OK = "0";

// —— 为什么这里**没有**速率闸 ——
// 与 Bybit 同理:额度按**账户自己那把 key** 算,一次同步端点数固定、不并挤,两个账户各花各的。
// 装了拦不到任何东西,还会把互不相干的账户排成一队白等。

// OKX v5 API constants. Only what the request layer needs: valuation and display constants (`STABLECOINS`, `EARN_RESIDUAL_MIN_USD`,
// `OKX_EARN_LOGO`) and the `OKX_API_BASE` env name belong to the adapter (the client takes the base's value).

export const OKX_API_BASE = "https://www.okx.com";
export const BALANCE_PATH = "/api/v5/account/balance"; // trading account (carries eqUsd)
export const FUNDING_BALANCES_PATH = "/api/v5/asset/balances"; // funding account (amount from bal)
export const SAVINGS_BALANCE_PATH = "/api/v5/finance/savings/balance"; // earn: flexible lending (amount from amt)
export const STAKING_ORDERS_ACTIVE_PATH = "/api/v5/finance/staking-defi/orders-active"; // earn: active on-chain orders
export const ASSET_VALUATION_PATH = "/api/v5/asset/asset-valuation"; // authoritative USD per bucket (query ccy)
export const POSITIONS_PATH = "/api/v5/account/positions"; // contract positions

// Quote currency of asset-valuation. It goes through the query (the signing step rebuilds it into requestPath, see client.ts), not welded into the path constant.
export const VALUATION_CCY = "USD";

export const HEADER_KEY = "OK-ACCESS-KEY";
export const HEADER_SIGN = "OK-ACCESS-SIGN";
export const HEADER_TIMESTAMP = "OK-ACCESS-TIMESTAMP";
export const HEADER_PASSPHRASE = "OK-ACCESS-PASSPHRASE";

// OKX signals errors as HTTP 200 + code (a string, "0" = OK), unlike Bybit's numeric retCode. These codes are credential / signature / permission problems.
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

// No rate gate: as with Bybit, quota is per account's own key and one sync's endpoint count is fixed and not contending; a gate would block nothing and
// queue unrelated accounts.

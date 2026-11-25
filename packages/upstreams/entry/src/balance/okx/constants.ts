// Also the issuer in `tokenRef.issued(...)`.
export const ID = "okx";
export const OKX_API_BASE = "https://www.okx.com";
// A proxy for when OKX refuses the Workers egress region; may embed a proxy key, never log it.
export const OKX_API_BASE_OVERRIDE = "OKX_API_BASE";

export const BALANCE_PATH = "/api/v5/account/balance"; // trading account (carries eqUsd)
export const FUNDING_BALANCES_PATH = "/api/v5/asset/balances";
export const SAVINGS_BALANCE_PATH = "/api/v5/finance/savings/balance"; // earn: flexible lending
export const STAKING_ORDERS_ACTIVE_PATH = "/api/v5/finance/staking-defi/orders-active";
export const ASSET_VALUATION_PATH = "/api/v5/asset/asset-valuation"; // authoritative USD per bucket
export const POSITIONS_PATH = "/api/v5/account/positions";
// The endpoint defaults to BTC.
export const VALUATION_QUERY = { ccy: "USD" } as const;

export const HEADER_KEY = "OK-ACCESS-KEY";
export const HEADER_SIGN = "OK-ACCESS-SIGN";
export const HEADER_TIMESTAMP = "OK-ACCESS-TIMESTAMP";
export const HEADER_PASSPHRASE = "OK-ACCESS-PASSPHRASE";

// Errors arrive as HTTP 200 + a string `code` ("0" = OK). These mean credentials, signature or
// permissions.
export const CODE_OK = "0";
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

// Fallback $1 valuation when the trading account lacks the coin.
export const STABLECOINS: ReadonlySet<string> = new Set(["USDT", "USDC", "DAI", "TUSD", "FDUSD"]);

// Only emit the unitemised-earn row (or the classic note) above this many USD.
export const EARN_RESIDUAL_MIN_USD = 1;

// OKX mark for the synthetic unitemised-earn row; a data URI so the client loads no third-party CDN.
export const OKX_EARN_LOGO =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzExMTMxOCIvPjxnIGZpbGw9IiNmZmYiPjxyZWN0IHg9IjQiIHk9IjQiIHdpZHRoPSI0LjYiIGhlaWdodD0iNC42Ii8+PHJlY3QgeD0iMTUuNCIgeT0iNCIgd2lkdGg9IjQuNiIgaGVpZ2h0PSI0LjYiLz48cmVjdCB4PSI5LjciIHk9IjkuNyIgd2lkdGg9IjQuNiIgaGVpZ2h0PSI0LjYiLz48cmVjdCB4PSI0IiB5PSIxNS40IiB3aWR0aD0iNC42IiBoZWlnaHQ9IjQuNiIvPjxyZWN0IHg9IjE1LjQiIHk9IjE1LjQiIHdpZHRoPSI0LjYiIGhlaWdodD0iNC42Ii8+PC9nPjwvc3ZnPg==";

// No rate gate: the quota follows each account's own key, and one fetch is a fixed six calls.

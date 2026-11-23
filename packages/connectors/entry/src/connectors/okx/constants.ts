// Also the issuer in `tokenRef.issued(...)`.
export const PROVIDER_ID = "okx";

// Fallback $1 valuation when the trading account lacks the coin and the oracle hasn't filled it.
export const STABLECOINS: ReadonlySet<string> = new Set(["USDT", "USDC", "DAI", "TUSD", "FDUSD"]);

// Only show the "unitemised earn" note when the earn bucket exceeds the itemised sum by more than this.
export const EARN_RESIDUAL_MIN_USD = 1;

// OKX mark for the synthetic unitemised-earn row; a data URI so the client loads no third-party CDN.
export const OKX_EARN_LOGO =
  "data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHZpZXdCb3g9IjAgMCAyNCAyNCI+PHJlY3Qgd2lkdGg9IjI0IiBoZWlnaHQ9IjI0IiByeD0iNSIgZmlsbD0iIzExMTMxOCIvPjxnIGZpbGw9IiNmZmYiPjxyZWN0IHg9IjQiIHk9IjQiIHdpZHRoPSI0LjYiIGhlaWdodD0iNC42Ii8+PHJlY3QgeD0iMTUuNCIgeT0iNCIgd2lkdGg9IjQuNiIgaGVpZ2h0PSI0LjYiLz48cmVjdCB4PSI5LjciIHk9IjkuNyIgd2lkdGg9IjQuNiIgaGVpZ2h0PSI0LjYiLz48cmVjdCB4PSI0IiB5PSIxNS40IiB3aWR0aD0iNC42IiBoZWlnaHQ9IjQuNiIvPjxyZWN0IHg9IjE1LjQiIHk9IjE1LjQiIHdpZHRoPSI0LjYiIGhlaWdodD0iNC42Ii8+PC9nPjwvc3ZnPg==";

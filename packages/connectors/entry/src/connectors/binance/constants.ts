// Also the issuer in `tokenRef.issued(...)`: changing it changes every binance token's identity.
export const PROVIDER_ID = "binance";

export const QUOTE_ASSET = "USDT";

// Treated as 1 USD (they have no `${asset}USDT` pair).
export const STABLECOINS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "BUSD",
  "FDUSD",
  "TUSD",
  "DAI",
]);

export const MARGIN_ASSET = "USDT";

// Stripped longest-first to avoid a partial match (BTCUSDT → BTC).
export const QUOTE_SUFFIXES: readonly string[] = ["USDT", "USDC", "BUSD", "FDUSD", "TUSD"];

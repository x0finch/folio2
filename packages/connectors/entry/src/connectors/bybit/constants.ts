// Also the issuer in `tokenRef.issued(...)`.
export const PROVIDER_ID = "bybit";

// Fallback $1 valuation for funding/earn rows, which carry no price of their own.
export const STABLECOINS: ReadonlySet<string> = new Set([
  "USDT",
  "USDC",
  "DAI",
  "TUSD",
  "FDUSD",
  "USD1",
  "USDE",
  "USDD",
]);

export const EARN_CATEGORIES = [
  { category: "FlexibleSaving", label: "Flexible" },
  { category: "OnChain", label: "On-chain" },
] as const;

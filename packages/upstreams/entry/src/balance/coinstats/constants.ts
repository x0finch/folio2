export const ID = "coinstats";
export const COINSTATS_API_BASE = "https://openapiv1.coinstats.app";
export const COINSTATS_API_KEY = "COINSTATS_API_KEY";
export const COINSTATS_API_BASE_OVERRIDE = "COINSTATS_API_BASE";
export const BALANCE_PATH = "/wallet/balance";
export const API_KEY_HEADER = "X-API-KEY";

// One key serves three chains and sync runs 6 accounts at once, so they contend for one quota. The
// free tier allows 2 requests/s (https://openapi.coinstats.app/); 1.6/s leaves headroom since a
// 429 counts too, with the burst of 2 the nominal limit allows.
export const RATE_LIMIT_BURST = 2;
export const RATE_LIMIT_WINDOW_MS = 1250;

// CoinStats' connection id per account kind; also the fallback chain of a coin without one.
export const CONNECTION_BY_CONNECTOR: Readonly<Record<string, string>> = {
  solana: "solana",
  sui: "sui-wallet", // CoinStats names this connection "sui-wallet", not "sui"
  cosmos: "cosmos",
};

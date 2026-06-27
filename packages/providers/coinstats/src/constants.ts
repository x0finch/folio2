import type { AccountType } from "@folio/core";

// CoinStats OpenAPI 常量(不硬编码散落,见原则 #8)。
export const COINSTATS_API_BASE = "https://openapiv1.coinstats.app";
export const BALANCE_PATH = "/wallet/balance";
// 服务端全局 key 在 globalKeys 里的键名 + 请求头名。
export const COINSTATS_API_KEY = "COINSTATS_API_KEY";
export const API_KEY_HEADER = "X-API-KEY";

// 本包服务的 type → CoinStats connectionId 映射(经 /wallet/blockchains 实测确认:
// Sui 是 "sui-wallet" 而非 "sui")。新增链在此加一项即可(方案 A 工厂据此摊平)。
export const CONNECTION_IDS: ReadonlyArray<{ accountType: AccountType; connectionId: string }> = [
  { accountType: "onchain_solana", connectionId: "solana" },
  { accountType: "onchain_sui", connectionId: "sui-wallet" },
  { accountType: "onchain_cosmos", connectionId: "cosmos" },
];

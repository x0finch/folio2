// Zerion API 常量(不硬编码散落进逻辑,见原则 #8)。
export const ZERION_API_BASE = "https://api.zerion.io";
// 全量仓位(代币 + DeFi,跨所有 EVM 链一次返回)。
export const POSITIONS_PATH = (address: string) => `/v1/wallets/${address}/positions/`;
// 轻量聚合(仅用于 validate 探活,负载远小于 positions)。
export const PORTFOLIO_PATH = (address: string) => `/v1/wallets/${address}/portfolio`;
// 服务端全局 key 在 globalKeys 里的键名。
export const ZERION_API_KEY = "ZERION_API_KEY";
// 滤掉垃圾币 + 以 USD 计价。
export const POSITIONS_QUERY = "filter[trash]=only_non_trash&currency=usd";
// EVM 地址格式。
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

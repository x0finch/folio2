// Hyperliquid API 常量(不硬编码散落进逻辑,见原则 #8)。
export const HYPERLIQUID_API_BASE = "https://api.hyperliquid.xyz";
// 所有只读查询走同一个 info 端点(POST + JSON body 指定 type)。
export const INFO_PATH = "/info";
// 永续账户状态(保证金汇总 + 仓位),body: { type, user }。
export const CLEARINGHOUSE_TYPE = "clearinghouseState";
// Hyperliquid 地址 = EVM 地址(0x + 40 hex)。本包自持,不跨 provider 依赖。
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

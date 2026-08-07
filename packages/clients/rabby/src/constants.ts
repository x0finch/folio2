// Rabby(实为 DeBank 后端)API 常量(不硬编码散落,见原则 #8)。
//
// **只有请求层要的那些在这里。** 老 provider 的 `DUST_USD`(展示过滤)、`EVM_ADDRESS_RE`
// (accountCreds 校验)属于适配层,不进 client(ADR 0036)。

// 这是谁 —— 进每个错误的 `upstream` 字段。
export const UPSTREAM = "rabby";

export const RABBY_API_BASE = "https://api.rabby.io";
export const CHAIN_LIST_PATH = "/v1/chain/list";
export const CACHE_TOKEN_LIST_PATH = "/v1/user/cache_token_list";
export const COMPLEX_PROTOCOL_LIST_PATH = "/v1/user/complex_protocol_list";
export const TOTAL_BALANCE_PATH = "/v1/user/total_balance"; // 最轻的端点,探活用
export const CHAINS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// 签名头里的客户端标识 —— 进签名计算,不能乱改。
export const RABBY_CLIENT = "Rabby";
export const RABBY_CLIENT_VERSION = "0.93.49";

// —— 速率闸 ——
// **为什么需要它**:rabby 掐的不是总量而是**瞬时并发** —— 实测(签名请求、同一 IP)串行 150 发
// 零 429,但 20 并发掉 5 发、第二轮 14 并发掉 12 发,而且被压过之后恢复得慢。
// 而 sync 的并发是 6、每个账户还要发 2~3 个请求 → 真实瞬时并发 ~12,正压在坎上。
//
// **策略是「从不撞」,不是「撞了再重试」**:重试的退避上限只有 5s,而 rabby 恢复更慢,
// 撞上了三次重试很可能全白打。所以 **limit=1 —— 不许突发**,请求被均匀摊成 8 次/秒,
// 代价是同一账户的第二发多等 125ms,换限速永不触发。
//
// 另外 rabby 的 429 **不带 Retry-After**(实测),所以退避是盲猜 —— 更加要指望闸而不是重试。
export const MAX_REQUESTS_PER_SECOND = 8;

// 闸的 key:rabby 的额度实测跟**签名**走(不跟出口 IP 走),所有账户共用同一份 ——
// 所以必须是一个全局的闸,不是每账户一个。
export const RATE_LIMIT_KEY = "rabby:signed";

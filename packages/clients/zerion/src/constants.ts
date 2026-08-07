// Zerion API 常量(不硬编码散落,见原则 #8)。
//
// **只有请求层要的那些在这里。** 老 provider 里的 `EVM_ADDRESS_RE`(accountCreds 校验)、
// `DEBT_POSITION_TYPES`(负债腿取负的解析规则)属于适配层,不进 client(ADR 0036)。
// `ZERION_API_KEY` 那个「env 变量名」的身份也归适配层 —— client 收 key 的**值**。

// 这是谁 —— 进每个错误的 `upstream` 字段。
export const UPSTREAM = "zerion";

export const ZERION_API_BASE = "https://api.zerion.io";
// 全量仓位(代币 + DeFi,跨所有 EVM 链一次返回)。
export const positionsPath = (address: string) => `/v1/wallets/${address}/positions/`;
// 轻量聚合(探活用,负载远小于 positions)。
export const portfolioPath = (address: string) => `/v1/wallets/${address}/portfolio`;
// 链清单:slug → external_id(hex 数字 chainId)的权威来源;近静态。
export const CHAINS_PATH = "/v1/chains/";
export const CHAINS_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h

// 滤掉垃圾币 + 以 USD 计价 + **不过滤头寸类型**:Zerion 该接口默认 filter[positions]=only_simple,
// 只回钱包现货、剔除全部 DeFi(协议)头寸 —— 不显式给 no_filter,defi 永远是空的
// (实测同一地址:默认 101 行 0 defi,no_filter 188 行 87 defi)。
export const POSITIONS_QUERY = {
  "filter[trash]": "only_non_trash",
  currency: "usd",
  "filter[positions]": "no_filter",
} as const;

// —— 速率闸 ——
// **为什么这里要装**:一次取数发 2 个请求而且是**并行**的,而 sync 在账户维度并发 6 →
// 瞬时 12 个请求打**同一把 key**(ZERION_API_KEY 是全部署共用的,不是每账户一把)。
// 免费 developer 档的文档限额是 **10 RPS**(60k 次/月),12 已经越线。
//
// 容量给 8、速率 8/s:常见情形(6 个账户 12 发)前 8 发直接走、剩下 4 发各错开 125ms,
// 总共只多约 0.5s;真要冲高也被摊到 8/s 以下。留 20% 余量,因为 429 本身也算一次请求。
// 出处:https://zerion.io/blog/top-questions-about-zerion-api/(developer 档 10 RPS / 60k 每月)
export const RATE_LIMIT_PER_SEC = 8;
export const RATE_LIMIT_BURST = 8;

// 闸的 key。**填的是「key 的名字」而不是 key 的值**(见 client-core `RateLimitOptions.key`)。
// 全局一把 key,所以所有账户共用这一个队。
export const RATE_LIMIT_KEY = "zerion:api-key";

// CoinStats OpenAPI 常量(不硬编码散落,见原则 #8)。
//
// **只有请求层要的那些在这里。** 老 provider 包的 constants.ts 里 `COINSTATS_API_KEY` 兼任
// 「env 变量名 / ctx.creds 的键名」—— 那两个身份属于适配层,不进 client(ADR 0036):
// client 收的是 key 的**值**,不知道它从哪个 env 变量来。这里只留它作为**限频 key** 的那个身份。

export const COINSTATS_API_BASE = "https://openapiv1.coinstats.app";
export const BALANCE_PATH = "/wallet/balance";
// 只需 API key、不需地址的端点 —— 用来实测 key 本身是否有效。
export const BLOCKCHAINS_PATH = "/wallet/blockchains";
export const API_KEY_HEADER = "X-API-KEY";

// —— 速率闸 ——
// **为什么这里要装**:CoinStats 是**一把 key 服务三条链**(sui / cosmos / solana),而 sync 在
// 账户维度并发 6 —— 同一个用户一次同步里,三条链的账户会同时挤这一把 key 的额度。
// 这是全仓最可能已经在悄悄丢数据的地方(429 被 sync 吞成 ok:false,用户只看到那个账户没刷上)。
//
// 免费档文档限额是 **2 请求/秒**(另有按 credit 计的月配额,单次多链调用比单链贵)。
// 出处:https://coinstats.app/api/ 与 https://openapi.coinstats.app/(free tier 2 rps / 20k credits 每月)
//
// 速率取 1.6/s(标称 2 的 80%,给 429 本身也算一次请求留余量),容量 2 —— 也就是标称值允许的
// 那点突发。三条链一起来时总共约 2.5 秒走完,比撞 429 之后赔一轮退避快。
export const RATE_LIMIT_PER_SEC = 1.6;
export const RATE_LIMIT_BURST = 2;

// 闸的 key。**填的是「key 的名字」而不是 key 的值** —— 值会进日志、进 Map 的键、进缓存的 URL
// (见 client-core `RateLimitOptions.key` 的判据)。三条链各建一个 client 也共享同一个队,
// 因为它们花的是同一把 key 的额度。
export const RATE_LIMIT_KEY = "coinstats:api-key";

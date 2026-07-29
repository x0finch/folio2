// CoinStats OpenAPI 常量(不硬编码散落,见原则 #8)。
export const COINSTATS_API_BASE = "https://openapiv1.coinstats.app";
export const BALANCE_PATH = "/wallet/balance";
// 只需 API key、不需地址的端点 —— 用来实测 provider key 本身是否有效(validateCreds)。
export const BLOCKCHAINS_PATH = "/wallet/blockchains";
// provider key 在 ctx.creds 里的键名(= app 注入的 env 变量名)+ 请求头名。
export const COINSTATS_API_KEY = "COINSTATS_API_KEY";
export const API_KEY_HEADER = "X-API-KEY";

// —— 速率闸 ——
// **为什么这里要装**:`COINSTATS_API_KEY` 是**一把 key 服务三个 connector**(sui / cosmos / solana),
// 而 sync 在账户维度并发 6 —— 同一个用户一次同步里,三条链的账户会同时挤这一把 key 的额度。
// 这是全仓最可能已经在悄悄丢数据的地方(429 被 sync 吞成 ok:false,用户只看到那个账户没刷上)。
//
// 免费档文档限额是 **2 请求/秒**(另有按 credit 计的月配额,单次多链调用比单链贵)。
// 出处:https://coinstats.app/api/ 与 https://openapi.coinstats.app/(free tier 2 rps / 20k credits 每月)
//
// 速率取 1.6/s(标称 2 的 80%,给 429 本身也算一次请求留余量),容量 2 —— 也就是标称值允许的
// 那点突发。三条链一起来时总共约 2.5 秒走完,比撞 429 之后赔一轮退避快。
export const RATE_LIMIT_PER_SEC = 1.6;
export const RATE_LIMIT_BURST = 2;

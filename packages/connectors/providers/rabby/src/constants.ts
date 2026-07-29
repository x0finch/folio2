// Rabby provider 常量(不硬编码散落进逻辑,见原则 #8)。

// provider id。也是速率闸的 key —— rabby 的额度跟签名走,所有账户共用同一份。
export const PROVIDER_ID = "rabby";

export const RABBY_API_BASE = "https://api.rabby.io";

// —— 端点 ——
// 关键的一条是 cache_token_list:**只收地址、一次回全链**(某公开地址实测 2302 行 / 62 条链)。
// `token_list` 必须逐链问(那地址 69 条链有余额 → 69 个请求,不可行),`all_token_list` 在
// api.rabby.io 上是 404(那是 DeBank 付费 OpenAPI 的端点)。
export const CHAIN_LIST_PATH = "/v1/chain/list";
export const CACHE_TOKEN_LIST_PATH = "/v1/user/cache_token_list";
export const COMPLEX_PROTOCOL_LIST_PATH = "/v1/user/complex_protocol_list";
export const TOTAL_BALANCE_PATH = "/v1/user/total_balance";

// 链清单近静态,进程内(isolate 级)缓存 24h 够。
export const CHAINS_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

// dust 闸:低于这个 USD 价值的**合约币**不产行(原生币豁免)。
// 由来见 parse.ts 的 parseTokens 注释 —— Zerion 靠服务端 only_non_trash,rabby 没有对应参数。
//
// 为什么是 $1 而不是 $0.01:同一地址实测,$1 砍掉一半行数(907 → 444)只丢 $104(总额的 0.01%),
// $1 以下的东西没人是特意持有的。想更贴近 Zerion 的行数可以抬到 10(219 行 ≈ Zerion 的 188 行,
// 丢 $880 / 0.10%)—— 但那会开始吞掉真实的小额持仓。
export const DUST_USD = 1;

// 并发闸:实测 ≤10 并发干净、14 以上开始掉、20 基本全掉,且被压过之后恢复慢。
// 8 是留了余量的档位(老仓库 axios 那个 throttle limit 也正好是 10 —— 那个数不是瞎写的)。
export const MAX_REQUESTS_PER_SECOND = 8;

// EVM 地址格式。
export const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

// 签名头里的客户端身份。**这两个是「跟着上游走的东西」** —— rabby 哪天加版本下限,
// 这里就是要改的地方(见 src/sign.ts 顶部的风险注释)。
export const RABBY_CLIENT = "Rabby";
export const RABBY_CLIENT_VERSION = "0.93.49";

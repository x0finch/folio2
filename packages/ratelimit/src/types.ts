// 限速的作用域。**三档不是三套 API** —— 调用方只声明「这份额度是谁的」,怎么实现由包决定。
//   · isolate —— 模块级桶。主力:零成本、无延迟、在自己那格里精确。**避免撞墙靠它**
//   · colo    —— 再加一层 Cache API 冷却标记(见 cooldown.ts):只止损、不管配额,撞墙之后
//                同一个数据中心的 isolate 一起收手
//   · global  —— Durable Object 真配额。**尚未实现**,声明成 global 会降级成 colo 并 warn 一次
//                (见 #17 M10.4:它只在「按 key 计费的上游 + 多用户同时同步」时才需要)
export type LimitScope = "isolate" | "colo" | "global";

export interface LimitPolicy {
  // 闸的 key = **上游拿来计量的那个东西**:全局共享一把 key 的取 key 名,按出口 IP 算的取
  // provider id,每账户自带凭据的用 `acquire(accountId)` 的 subKey 区分。
  //
  // 判据先过这一条:**只在「多个调用挤同一份额度」的地方装闸**。每账户自带 key、一次同步里
  // 只发一两个请求的上游(binance 的签名端点、okx),桶永远是满的,闸一次都拦不到 —— 纯装饰。
  key: string;
  capacity: number; // 允许多大的突发(1 = 不许突发,均匀摊开)
  ratePerSec: number; // 突发用完后的放行速率
  scope?: LimitScope; // 默认 isolate
  clock?: () => number; // 默认 Date.now,测试注入
  sleep?: (ms: number) => Promise<void>; // 默认 setTimeout,测试注入
  cache?: CooldownStore; // 默认 caches.open(),测试注入
  log?: LimitLogger; // 默认静默;传进来才会报告「colo 档没生效」
  // 冷却期内怎么拒绝。默认抛 RateLimitedError;传这个钩子就能抛调用方自己的错误类型
  // (provider 对 sync 的契约是「失败一律 ProviderError」)。必须抛,不能返回。
  onCooldown?: (remainingMs: number, key: string) => never;
}

export interface Limit {
  // 过闸。subKey 拼在 key 后面 —— 每账户独立额度用它区分。
  acquire(subKey?: string): Promise<void>;
  // 吃到 429 时告诉闸:这份额度冷却到 now + ms 之前别再打了。ms 会被夹到 COOLDOWN_MAX_MS。
  // **由调用方显式调**,包不去嗅探 Response —— 那会让 @folio/ratelimit 依赖 HTTP 语义。
  cooldown(ms: number | undefined, subKey?: string): Promise<void>;
}

export type LimitLogger = (message: string, properties?: Record<string, unknown>) => void;

// Cache API 里只用到这两个方法 —— 收窄成接口,于是 node 测试注入一个假的就行(node 里没有
// `caches`),也不必把整个 CacheStorage 的类型拖进来。
export interface CooldownStore {
  match(request: string): Promise<Response | undefined>;
  put(request: string, response: Response): Promise<void>;
}

export interface RetryInfo {
  attempt: number; // 第几次尝试失败了(1 = 首次)
  error: unknown;
  waitMs: number;
}

export interface RetryOpts {
  attempts: number; // **总尝试次数**,不是重试次数。1 = 从不重试
  maxWaitMs: number; // 单次等待上限(退避和 Retry-After 都受它约束)
  baseMs: number; // 指数退避基数,同时是抖动幅度
  // Retry-After 超过 maxWaitMs 时怎么办:
  //   · throw(默认)—— 不等,立刻抛,错误上仍带着 retryAfterMs 供调用方决策。
  //     用户在等的路径必须用这个,免费档的 Retry-After 能给到 60s,等下去等于把请求挂死
  //   · clamp —— 夹到 maxWaitMs 继续等(sync 迁移前的行为)
  exceedsMaxWait?: "throw" | "clamp";
  sleep?: (ms: number) => Promise<void>;
  random?: () => number; // 抖动源,默认 Math.random;测试注入固定值
  // 默认鸭子类型:看 `err.retryable === true`。四个错误类(ProviderError / CoinGeckoError /
  // TokenError / blockbook 的)字段名本来就一样,不需要统一基类。
  isRetryable?: (error: unknown) => boolean;
  onRetry?: (info: RetryInfo) => void; // 每次重试**之前**回调,日志钩子
}

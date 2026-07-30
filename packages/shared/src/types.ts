// 时隙游标存在哪。**它的作用域就是限速的作用域**:
//   · cache(默认)—— Cache API,同一个数据中心的 isolate 共享;缓存不可用时**兜底退到 memory**
//   · memory        —— 模块级 Map,每个 isolate 一份。isolate 一回收就归零、新 isolate 开局满额
//                      突发,所以生产别单用;测试用它
//
// cache 这一档**没有原子读改写**(两个 isolate 会读到同一个游标),所以它给不了精确配额。
// 这是明知接受的:我们要的是**削峰**,不是严格限频 —— 漏出去的那几发由 429 + 重试兜。
// 真要精确得上 Durable Object(见 #17),而那需要多用户同时同步才划得来。
export interface SlotStore {
  // 把 key 的时隙游标往后推 spacingMs,返回**推之前**的值(不早于 now)——也就是本次拿到的时隙。
  //
  // **实现必须保证同一 isolate 内的原子性**:读和写之间不能有 `await`,否则两个并发调用会读到
  // 同一个游标、各自以为拿到了那个时隙,闸就漏了。跨 isolate 的原子性做不到,也不要求(见上)。
  advance(key: string, spacingMs: number, now: number): Promise<number>;
  // 仅测试用:清掉这个实现自己的状态。**由实现方自己清** —— 否则 resetRateLimitsForTests
  // 得知道每种存储的内部长什么样。测试里传的假 store 不需要它,所以是可选的。
  reset?(): void;
}

export type StoreChoice = "cache" | "memory" | SlotStore;

export interface RateLimitOptions {
  // 闸的 key = **上游拿来计量的那个东西**。三种常见情形都只是往这里填不同的字符串:
  //   · 全局共享一把 API key → 填 **key 的名字**(如 `COINGECKO_API_KEY`)。绝不填 key 的值 ——
  //     它会进日志、进 Map 的键、进缓存的 URL
  //   · 按出口 IP 算(免签的公开端点几乎都是)→ 填一个 provider 级的常量,如 `binance:public`
  //   · 每账户自带一把 key → 填 provider 名,调用时用 `limit(run, accountId)` 分队
  //
  // 前两种是「一份额度、很多调用者」,第三种是「很多份额度、各自一个调用者」—— 上游数的都是
  // API key,区别只在我们手里有几把。
  //
  // **装闸之前先过这一问:这份额度有几个调用者在挤?** 每账户自带 key、一次同步只发一两发的
  // 上游(binance 的签名端点、okx),队永远是空的 —— 闸拦不到任何东西,还会把两个互不相干的
  // 账户排成一队白等。那种地方别装。这条判断类型系统帮不上,只能靠 review。
  key: string;
  limit: number; // 每 interval 允许几发
  interval: number; // 窗口毫秒
  store?: StoreChoice; // 默认 "cache";测试传 "memory" 或自己的实现
  clock?: () => number; // 默认 Date.now,测试注入
  sleep?: (ms: number) => Promise<void>; // 默认 setTimeout,测试注入
}

// 闸:**调用方把它放模块顶层**,每个请求进它的闭包。
// 请求写在参数里而不是「先 acquire 再自己发」——想绕过它得刻意不调,不会写漏。
export type RateLimiter = <T>(run: () => Promise<T>, subKey?: string) => Promise<T>;

// 只在本文件内被 RetryOpts.onRetry 引用 —— 不导出(仓库规则:只在自己文件里用到就别 export)。
interface RetryInfo {
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

// —— http:限频 + 重试 + 失败归类 的薄包装(见 http.ts)——

// 非 2xx / 出不去 / 读不动 的五种归类。**包只负责归类,不负责变成哪个错误类** ——
// 每家抛自己的(provider 抛 ProviderError、client 抛自己的),所以由 `toFailure` 决定。
// 只被同文件的 Failure 引用 —— 不导出(仓库规则)。
type FailureKind =
  | "network" // 压根没出去(DNS / 断网 / fetch 抛了)
  | "rate-limited" // 被限流(默认 429;binance 还要认 418)
  | "auth" // 401 / 403,凭据被拒
  | "upstream" // 其余非 2xx
  | "parse"; // 出去了、回来了,但读不成 JSON

export interface Failure {
  kind: FailureKind;
  // 出事的**路径**(pathname)。**刻意不带 query** —— 那里面有地址、签名这类东西,
  // 而这个对象会进错误消息和日志(原则 #5 的红线)。
  where: string;
  status?: number;
  retryAfterMs?: number; // 上游 Retry-After 头解析出来的(秒数或 HTTP-date 都认)
  cause?: unknown;
}

export interface FetchOptions {
  query?: Record<string, string | number | undefined>; // undefined 的键不参与
  init?: RequestInit;
  // 404 当成「没有这个东西」而不是故障 → 返回 null。只对「按 id 查一个东西」的端点开。
  notFoundAsNull?: boolean;
}

export interface HttpClientOptions {
  // **必填**:五个真实调用点都有基址,而少了它 `new URL("/path")` 会当场炸 —— 与其留一个
  // 「忘了传就报 Invalid URL」的失败模式,不如在类型上要求它。
  baseUrl: string;
  // 每次请求的头。**是函数而不是对象** —— 签名类的头(rabby 的 wasm 签名、binance 的 HMAC)
  // 要按路径和参数算,而且是异步的。
  headers?: (path: string, options: FetchOptions | undefined) => HeadersInit | Promise<HeadersInit>;
  limit?: RateLimiter; // 不传 = 不限频(判据见 RateLimitOptions.key 的注释:队里没人挤就别装)
  retry?: RetryOpts; // 不传 = 不重试(provider 那条路由 @folio/sync 统一重试)
  rateLimitedStatuses?: number[]; // 默认 [429]
  // 把归类结果变成调用方自己的错误。**必须抛,不能返回** —— 返回的话包无从知道该继续还是停。
  toFailure: (failure: Failure) => Error;
}

// 发一个请求,回解析好的 JSON(`notFoundAsNull` 且 404 时回 null)。
export type Fetcher = (path: string, options?: FetchOptions) => Promise<unknown>;

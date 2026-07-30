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

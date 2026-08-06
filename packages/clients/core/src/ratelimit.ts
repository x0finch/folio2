import { Clock, Duration, Effect } from "effect";
import { resolveStore, type StoreChoice } from "./slot-store";

// 出站请求的速率闸。**目标是削峰,不是严格限频** —— 严格那档在 Workers 上只有 Durable Object 能做
// (见 #17),而我们不需要:漏出去的那几发由 429 + 重试兜底。
//
// 算的东西只有一个数:**时隙游标**(tat, theoretical arrival time)。
//   · 本次拿到的时隙 = 推之前的游标(不早于 now);放行时刻 = 它 - 突发额度
//   · 每放行一发,游标往后推一个间距
//   · 游标不早于 now —— 闲置过后它落在过去,突发额度自动补满(不惩罚闲置)
//
// 游标存哪由 `store` 决定,见 slot-store.ts(那里也写了为什么不用 Effect 自带的 `RateLimiter`)。
//
// **相对迁移前那版少了三个参数**:`clock` / `sleep` 由 Effect 的 `Clock` 服务接管(测试 provide
// `TestContext` 即可确定性推进),而全局的 `bypassRateLimitsForTests` 开关也不再需要 —— 它存在的
// 唯一理由是集成测试里闸按墙钟真等,`TestClock` 下等待瞬间完成,没有可绕的东西。少一个全局可变
// 状态,也少一条「忘了 reset 就串味」的路。

export interface RateLimitOptions {
  // 闸的 key = **上游拿来计量的那个东西**。三种常见情形都只是往这里填不同的字符串:
  //   · 全局共享一把 API key → 填 **key 的名字**(如 `COINGECKO_API_KEY`)。绝不填 key 的值 ——
  //     它会进日志、进 Map 的键、进缓存的 URL
  //   · 按出口 IP 算(免签的公开端点几乎都是)→ 填一个 provider 级的常量,如 `binance:public`
  //   · 每账户自带一把 key → 填 provider 名,调用时用 `limit.forKey(accountId)` 分队
  //
  // 前两种是「一份额度、很多调用者」,第三种是「很多份额度、各自一个调用者」—— 上游数的都是
  // API key,区别只在我们手里有几把。
  //
  // **装闸之前先过这一问:这份额度有几个调用者在挤?** 每账户自带 key、一次同步只发一两发的
  // 上游(binance 的签名端点、okx),队永远是空的 —— 闸拦不到任何东西,还会把两个互不相干的
  // 账户排成一队白等。那种地方别装。这条判断类型系统帮不上,只能靠 review。
  readonly key: string;
  readonly limit: number; // 每 interval 允许几发
  readonly interval: number; // 窗口毫秒
  readonly store?: StoreChoice; // 默认 "cache";测试传 "memory" 或自己的实现
}

// 闸:**调用方把它放模块顶层**,每个请求的 Effect 进它。
// 请求写在参数里而不是「先 acquire 再自己发」——想绕过它得刻意不调,不会写漏。
//
// 形状与 Effect 自带的 `RateLimiter` 一致(`<A,E,R>(task) => Effect<A,E,R>`),所以能被
// `Function.compose` 串起来叠多档配额,和自带那个可以混用。
export interface RateLimiter {
  <A, E, R>(task: Effect.Effect<A, E, R>): Effect.Effect<A, E, R>;
  // 同一档配额下按子键分队(每账户自带一把 key 的情形)。
  readonly forKey: (
    subKey: string,
  ) => <A, E, R>(task: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>;
}

export function defineRateLimit(opts: RateLimitOptions): RateLimiter {
  if (!Number.isInteger(opts.limit) || opts.limit < 1) {
    throw new Error(`ratelimit: limit must be an integer >= 1 (${opts.key})`);
  }
  if (!Number.isFinite(opts.interval) || opts.interval <= 0) {
    throw new Error(`ratelimit: interval must be a positive finite number (${opts.key})`);
  }

  const store = resolveStore(opts.store);
  const spacing = opts.interval / opts.limit;
  const burst = (opts.limit - 1) * spacing;

  const gate =
    (subKey: string | undefined) =>
    <A, E, R>(task: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const key = subKey === undefined ? opts.key : `${opts.key}:${subKey}`;
        const now = yield* Clock.currentTimeMillis;
        const tat = yield* store.advance(key, spacing, now);
        const waitMs = tat - burst - now;
        if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs));
        return yield* task;
      });

  const limiter = gate(undefined) as RateLimiter;
  return Object.assign(limiter, { forKey: (subKey: string) => gate(subKey) });
}

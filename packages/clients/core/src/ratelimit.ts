import { Clock, Context, Duration, Effect, Option, RateLimiter, type Scope } from "effect";
import { cursorFor } from "./slot-cursor";

// 出站请求的速率闸。**出口就是 Effect 官方的 `RateLimiter`** —— 同一个类型、同一套构造契约
// (`Effect<RateLimiter, never, Scope>`),所以 `RateLimiter.withCost` / `Function.compose` 叠多档
// 这些组合子直接可用,我们不自造平行宇宙。
//
// 唯一多出来的是**档位**,它决定额度桶**存在哪**:
//
//   · `isolated`(默认)—— 额度跨 CF Workers 的 isolate 共享。官方那套(semaphore + 后台 refill fiber)
//     的状态是内存里的信号量,跨不了 isolate;而 CF 什么时候开新 isolate 我们控制不了,每个新
//     isolate 从满额开始就等于没限。所以这一档自己实现,见下
//   · `memory`       —— **直接委托官方实现**,一行。进程内、状态绑在 `Scope` 上,官方的
//     token-bucket / fixed-window 两种算法都能用。测试和单进程场景用这档
//
// **为什么 `isolated` 只能自己写**:跨 isolate 共享的载体是 Cache API,它只能存一个值、没有原子
// 读改写。能塞进「一个数」的限频算法是 GCRA(时隙游标),不是信号量 —— 算法选择是被载体逼出来的,
// 不是偏好。

export type RateLimitScope = "memory" | "isolated";

export interface RateLimitOptions extends RateLimiter.RateLimiter.Options {
  // 闸的 key = **上游拿来计量的那个东西**。三种常见情形都只是往这里填不同的字符串:
  //   · 全局共享一把 API key → 填 **key 的名字**(如 `COINGECKO_API_KEY`)。绝不填 key 的值 ——
  //     它会进日志、进 Map 的键、进缓存的 URL
  //   · 按出口 IP 算(免签的公开端点几乎都是)→ 填一个 provider 级的常量,如 `binance:public`
  //   · 每账户自带一把 key → 填 provider 名 + 账户 id
  //
  // 前两种是「一份额度、很多调用者」,第三种是「很多份额度、各自一个调用者」—— 上游数的都是
  // API key,区别只在我们手里有几把。
  //
  // **装闸之前先过这一问:这份额度有几个调用者在挤?** 每账户自带 key、一次同步只发一两发的
  // 上游(binance 的签名端点、okx),队永远是空的 —— 闸拦不到任何东西,还会把两个互不相干的
  // 账户排成一队白等。那种地方别装。这条判断类型系统帮不上,只能靠 review。
  //
  // `memory` 档用不到它(桶在 scope 里,天然隔离),但仍然必填 —— 同一个闸切档时不该改调用点。
  readonly key: string;
  // **显式选档,给「我就是要测这一档」用**(本包测两档算法本身时)。日常不传:
  // 生产就是 `isolated`,测试要换档 provide 下面那个服务 —— 见那里的说明。
  readonly scope?: RateLimitScope;
}

// 换档用的**可选服务** —— `Effect.serviceOption` 读它,所以 **`R` 通道不受污染**,
// 与 `Fetcher` / `SlotCacheOverride` / `RabbySigner` 同一套。
//
// 为什么不是每个 client 的 config 上一个 `rateLimitScope` 字段:那是构造器注入,而它**只为测试
// 存在**(生产从不传)。四个 client 各写一遍 `config.rateLimitScope ?? "isolated"` 的后果是
// **默认值有五个地方定义**,而且和本模块自己的默认值打过架(这里曾经默认 `memory`,四个调用点
// 又各自覆盖回 `isolated`——真正的默认藏在调用点里,读这个文件是看不出来的)。
//
// 现在只有一个默认:不 provide 就是 `isolated`,也就是生产的样子。
export class RateLimitScopeOverride extends Context.Tag("client-core/RateLimitScopeOverride")<
  RateLimitScopeOverride,
  RateLimitScope
>() {}

// **默认 `isolated`,也就是生产的样子。** 进程内那档只在测试和单进程场景成立,而 CF Workers 上
// 每个请求一次 `runPromise`、随时会开新 isolate —— 桶只活在进程内就等于没限。默认值该是
// 「不配也安全」的那个,不是「跑得最顺」的那个。
const scopeFor = (explicit?: RateLimitScope): Effect.Effect<RateLimitScope> =>
  explicit !== undefined
    ? Effect.succeed(explicit)
    : Effect.map(Effect.serviceOption(RateLimitScopeOverride), (o) =>
        Option.isSome(o) ? o.value : "isolated",
      );

// 与官方 `RateLimiter.make` 同签名(多一个 `key`),所以两者可以互换、可以 compose。
export function make(
  options: RateLimitOptions,
): Effect.Effect<RateLimiter.RateLimiter, never, Scope.Scope> {
  return Effect.flatMap(scopeFor(options.scope), (scope) =>
    scope === "memory" ? RateLimiter.make(options) : isolated(options),
  );
}

// —— isolated:GCRA(时隙游标),状态一个数,所以能跨 isolate ——
//
// 算的东西只有一个数:**时隙游标**(tat, theoretical arrival time)。
//   · 本次拿到的时隙 = 推之前的游标(不早于 now);放行时刻 = 它 - 突发额度
//   · 每放行一发,游标往后推一个间距 × cost
//   · 游标不早于 now —— 闲置过后它落在过去,突发额度自动补满(不惩罚闲置)
//
// **目标是削峰,不是严格限频** —— 严格那档在 Workers 上只有 Durable Object 能做(见 #17),
// 而我们不需要:漏出去的那几发由 429 + 重试兜底。
//
// **两处能力差,写清楚免得踩**:
//   · `algorithm` 被忽略 —— GCRA 就是 token-bucket 的连续时间版(令牌按固定速率恢复);fixed-window
//     用一个游标表达不了。要 fixed-window 只能用 `memory` 档
//   · `RateLimiter.withCost` 不生效 —— 官方靠一个没导出的 internal `FiberRef` 传权重,这一档读不到。
//     自造一个平行的 FiberRef 会让「该用哪个 withCost」变成必须记住的陷阱,不如没有。目前仓里没有
//     分权重的上游(所有端点等价一发);真要用时应该连同官方档一起想清楚再补
const isolated = (
  options: RateLimitOptions,
): Effect.Effect<RateLimiter.RateLimiter, never, Scope.Scope> =>
  Effect.sync(() => {
    const spacing = Duration.toMillis(Duration.decode(options.interval)) / options.limit;
    const burst = (options.limit - 1) * spacing;
    // 游标按 key 取,**跨 `make` 调用共享** —— 这一档的状态刻意不在 `Scope` 里:CF Workers 上每个
    // 请求一次 `runPromise`、Layer memoisation 是 per-run 的,状态放 scope 就等于每请求重置。
    const cursor = cursorFor(options.key);

    return <A, E, R>(task: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const tat = yield* cursor.advance(spacing, now);
        const waitMs = tat - burst - now;
        if (waitMs > 0) yield* Effect.sleep(Duration.millis(waitMs));
        return yield* task;
      });
  });

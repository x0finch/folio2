import { Clock, Effect, type RateLimiter } from "effect";
import { HttpFailure, type SigningFailure } from "./errors";
import { currentFetch } from "./fetcher";

// 一个薄的 fetch 包装:**限频 → 出网 → 归类失败**。
//
// 相对迁移前 `@folio/shared` 那版少了两样,都是刻意的:
//
// **不再收 `retry` 选项。** 重试由调用方 `Effect.retry(策略)` 加在外面。老版把重试收进来是因为
// 「闸必须在重试里面,否则退避完立刻插队」这条语义只能由包自己保证;而 `Effect.retry` 重跑的是
// **整个 effect**,闸就在里面,每次重试自然重新排队 —— 语义自动正确,不需要包替调用方管。换来的是
// ADR 0035 想要的那件事:重试策略成为**可组合的值**,谁调谁决定,而不是每个 client 各写一份 opts。
//
// **不再收 `toFailure` 回调。** 归类结果就是 `HttpFailure`,调用方用 `Effect.mapError` 转成自己的
// 错误类型。老版让包在归类点调用方的回调、抛调用方的类,结果是「这个请求会失败成什么」不在类型里
// (`Fetcher` 返回 `Promise<unknown>`);现在写进签名,忘了映射就是编译错误。

// Retry-After:纯秒数 或 HTTP-date → 毫秒;缺失/无效 → undefined。
// **不导出** —— 调用方拿到的是 `HttpFailure.retryAfterMs`,不需要自己解析头(迁移前仓库里有三份
// 重复实现,正是因为每家都自己解一遍)。
function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : undefined;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : undefined;
}

const DEFAULT_RATE_LIMITED = [429];

export interface RequestOptions<Ctx = undefined> {
  readonly query?: Record<string, string | number | undefined>; // undefined 的键不参与
  readonly init?: RequestInit;
  // 404 当成「没有这个东西」而不是故障 → 返回 null。只对「按 id 查一个东西」的端点开。
  readonly notFoundAsNull?: boolean;
  // 传给 `headers()` 的**每请求上下文**。**包不看它的内容**,只负责递过去。
  // 为什么需要:有些上游的凭据是每请求现取的(zerion / coinstats 的 key 来自 ctx.creds,
  // 不是模块级常量),而 `headers()` 是在包里被调用的,拿不到调用点的闭包。
  readonly context?: Ctx;
}

export interface HttpConfig<Ctx = undefined, HeaderError = SigningFailure> {
  // **必填**:所有真实调用点都有基址,而少了它 `new URL("/path")` 会当场炸 —— 与其留一个
  // 「忘了传就报 Invalid URL」的失败模式,不如在类型上要求它。
  readonly baseUrl: string;
  // 每次请求的头。**是函数而不是对象** —— 签名类的头(rabby 的 wasm 签名、binance 的 HMAC)
  // 要按路径和参数算,而且可能失败。它的错误进错误通道,**不被归类成传输故障**:
  // 归错了会退化成「三次退避全白打」,还把真正的原因盖掉。
  //
  // 错误类型是**参数**(默认 `SigningFailure`)—— 不是所有签名头都失败成同一个东西
  // (rabby 走 wasm),写死会逼后来者要么硬套要么改这里。
  readonly headers?: (
    path: string,
    options: RequestOptions<Ctx> | undefined,
  ) => Effect.Effect<HeadersInit, HeaderError>;
  readonly limit?: RateLimiter.RateLimiter; // 不传 = 不限频(判据见 RateLimitOptions.key 的注释:队里没人挤就别装)
  readonly rateLimitedStatuses?: readonly number[]; // 默认 [429]
}

// 发一个请求,回解析好的 JSON(`notFoundAsNull` 且 404 时回 null)。
//
// **`A` 是调用方声明的期望形状,包内不校验** —— 一次 `as A`,就在下面那个 `Effect.map` 里。
// 为什么是泛型而不是 `unknown`:返回 `unknown` 的话每个端点方法都要在自己那行写一次
// `as Effect.Effect<Foo, E>`,强转散在 N 个调用点、还顺手把错误类型也一起断言掉了。收成一个
// 类型参数之后,调用点写的是 `get<SpotAccount>(path)` —— 一眼看出这是断言,而错误类型仍由包保证。
//
// **校验本身是另一件事**:上游给的形状对不对,现在没人查。ADR 0035 把 `Effect.Schema` 的评估
// 推到 connectors 那一步(#362 第 3 站),到那时这里改成收一个 schema、返回 `Effect<A, ... | ParseError>`
// 是增量改动 —— 调用点已经在声明期望类型了,只是从断言变成校验。
export type Requester<Ctx = undefined, HeaderError = SigningFailure> = <A = unknown>(
  path: string,
  options?: RequestOptions<Ctx>,
) => Effect.Effect<A, HttpFailure | HeaderError>;

export function makeRequester<Ctx = undefined, HeaderError = SigningFailure>(
  config: HttpConfig<Ctx, HeaderError>,
): Requester<Ctx, HeaderError> {
  const rateLimited = new Set(config.rateLimitedStatuses ?? DEFAULT_RATE_LIMITED);

  return <A>(path: string, options?: RequestOptions<Ctx>) => {
    const once = Effect.gen(function* () {
      const url = new URL(`${config.baseUrl}${path}`);
      for (const [k, v] of Object.entries(options?.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
      // **失败信息里只带 pathname,不带 query。** query 里有地址、签名这类东西,而这个对象会进
      // 错误消息和日志(原则 #5 的红线)。
      const where = url.pathname;

      const doFetch = yield* currentFetch;
      const headers = config.headers ? yield* config.headers(path, options) : undefined;

      const res = yield* Effect.tryPromise({
        // **没配 `headers()` 时不能写 `headers: undefined`** —— 那会把调用方放在 `init.headers`
        // 里的头静默抹掉。配了就以 `headers()` 为准(它是「这个上游的头」,比单发的更权威)。
        try: () => doFetch(url, headers ? { ...options?.init, headers } : options?.init),
        catch: (cause) => new HttpFailure({ kind: "network", where, cause }),
      });

      if (!res.ok) {
        if (rateLimited.has(res.status)) {
          const now = yield* Clock.currentTimeMillis;
          return yield* new HttpFailure({
            kind: "rate-limited",
            where,
            status: res.status,
            retryAfterMs: parseRetryAfter(res.headers.get("retry-after"), now),
          });
        }
        if (res.status === 401 || res.status === 403) {
          return yield* new HttpFailure({ kind: "auth", where, status: res.status });
        }
        // 「这个东西不存在」对某些端点是正常答案,不是故障(比如按合约查币)。
        if (res.status === 404 && options?.notFoundAsNull) return null;
        return yield* new HttpFailure({ kind: "upstream", where, status: res.status });
      }

      return yield* Effect.tryPromise({
        try: () => res.json(),
        catch: (cause) => new HttpFailure({ kind: "parse", where, cause }),
      });
    });

    const gated = config.limit ? config.limit(once) : once;
    // 全包唯一一处形状断言 —— 见 `Requester` 的注释。
    return Effect.map(gated, (value) => value as A);
  };
}

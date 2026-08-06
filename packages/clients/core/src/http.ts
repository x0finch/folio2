import { Clock, Effect, type RateLimiter } from "effect";
import { HttpFailure, type SigningFailure } from "./errors";

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

export interface HttpConfig<Ctx = undefined> {
  // **必填**:所有真实调用点都有基址,而少了它 `new URL("/path")` 会当场炸 —— 与其留一个
  // 「忘了传就报 Invalid URL」的失败模式,不如在类型上要求它。
  readonly baseUrl: string;
  // 每次请求的头。**是函数而不是对象** —— 签名类的头(rabby 的 wasm 签名、binance 的 HMAC)
  // 要按路径和参数算,而且可能失败。它的错误进错误通道(`SigningFailure`),**不被归类成传输故障**:
  // 归错了会退化成「三次退避全白打」,还把真正的原因盖掉。
  readonly headers?: (
    path: string,
    options: RequestOptions<Ctx> | undefined,
  ) => Effect.Effect<HeadersInit, SigningFailure>;
  readonly limit?: RateLimiter.RateLimiter; // 不传 = 不限频(判据见 RateLimitOptions.key 的注释:队里没人挤就别装)
  readonly rateLimitedStatuses?: readonly number[]; // 默认 [429]
  // 仅测试注入。生产不传 —— 用全局 fetch,且**必须 bind**:在 CF Workers 上把 fetch 存进变量再调
  // 会丢 this,出网静默失败。
  readonly fetch?: typeof globalThis.fetch;
}

// 发一个请求,回解析好的 JSON(`notFoundAsNull` 且 404 时回 null)。
export type Requester<Ctx = undefined> = (
  path: string,
  options?: RequestOptions<Ctx>,
) => Effect.Effect<unknown, HttpFailure | SigningFailure>;

export function makeRequester<Ctx = undefined>(config: HttpConfig<Ctx>): Requester<Ctx> {
  const rateLimited = new Set(config.rateLimitedStatuses ?? DEFAULT_RATE_LIMITED);
  const doFetch = config.fetch ?? globalThis.fetch.bind(globalThis);

  return (path, options) => {
    const once = Effect.gen(function* () {
      const url = new URL(`${config.baseUrl}${path}`);
      for (const [k, v] of Object.entries(options?.query ?? {})) {
        if (v !== undefined) url.searchParams.set(k, String(v));
      }
      // **失败信息里只带 pathname,不带 query。** query 里有地址、签名这类东西,而这个对象会进
      // 错误消息和日志(原则 #5 的红线)。
      const where = url.pathname;

      const headers = config.headers ? yield* config.headers(path, options) : undefined;

      const res = yield* Effect.tryPromise({
        try: () => doFetch(url, { ...options?.init, headers }),
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

    return config.limit ? config.limit(once) : once;
  };
}

import { Clock, Effect, type RateLimiter } from "effect";
import { HttpFailure, type SigningFailure } from "./errors";
import { currentFetch } from "./fetcher";
import { type ClassifyOptions, classifyFailure, type UpstreamError } from "./upstream-error";

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
  // 这是谁。进每个错误的 `upstream` 字段 —— 类型合并之后「是谁失败的」只能靠数据带。
  readonly upstream: string;
  // 每次请求的头。**是函数而不是对象** —— 签名类的头(rabby 的 wasm 签名、binance 的 HMAC)
  // 要按路径和参数算,而且可能失败。它的错误进错误通道,**不被归类成传输故障**:
  // 归错了会退化成「三次退避全白打」,还把真正的原因盖掉。
  readonly headers?: (
    path: string,
    options: RequestOptions<Ctx> | undefined,
  ) => Effect.Effect<HeadersInit, SigningFailure>;
  readonly limit?: RateLimiter.RateLimiter; // 不传 = 不限频(判据见 RateLimitOptions.key 的注释:队里没人挤就别装)
  readonly rateLimitedStatuses?: readonly number[]; // 默认 [429]
  // 上游特有的**传输层**归类差异。返回 undefined 就走默认规则。
  // 例:binance 用 HTTP 400 表达「这份签名请求被拒」,那是凭据问题而不是上游的锅。
  readonly classifyOverride?: ClassifyOptions["override"];
  // 上游特有的**业务层**错误:HTTP 200,但 body 里说不行。
  //
  // 为什么是这一层的事:CEX 普遍这么干(bybit 的数字 `retCode`、okx 的字符串 `code`),而
  // **不查它的后果是静默丢数据** —— 签名错会被当成功、`result` 为空,最后表现成「这个账户
  // 余额是 0」。放在这里,「一发请求算不算成功」就只有一个答案,不必每个 client 各写一个
  // `get()` 包装去 flatMap 一遍(那是两份同构代码,也是漏掉一个端点的机会)。
  readonly checkBody?: (body: unknown, where: string) => UpstreamError | undefined;
}

// 发一个请求,回解析好的 JSON(`notFoundAsNull` 且 404 时回 null)。
//
// **错误就是 `UpstreamError`,不是传输层的中间态。** `HttpFailure` / `SigningFailure` 是归类
// **过程**用的,没有任何一个 client 想要它们:七家各自 `Effect.mapError(classify)` 一遍,
// 是同一句样板抄七份,还把「这个请求会失败成什么」的答案推迟了一层。归类是这个包的活,
// 那就在这里做完。
//
// **`A` 是调用方声明的期望形状,包内不校验** —— 一次 `as A`,就在下面那个 `Effect.map` 里。
// 为什么是泛型而不是 `unknown`:返回 `unknown` 的话每个端点方法都要在自己那行写一次
// `as Effect.Effect<Foo, E>`,强转散在 N 个调用点、还顺手把错误类型也一起断言掉了。收成一个
// 类型参数之后,调用点写的是 `get<SpotAccount>(path)` —— 一眼看出这是断言,而错误类型仍由包保证。
//
// **校验本身是另一件事**:上游给的形状对不对,现在没人查。ADR 0035 把 `Effect.Schema` 的评估
// 推到 connectors 那一步(#362 第 3 站),到那时这里改成收一个 schema、返回 `Effect<A, ... | ParseError>`
// 是增量改动 —— 调用点已经在声明期望类型了,只是从断言变成校验。
export type Requester<Ctx = undefined> = <A = unknown>(
  path: string,
  options?: RequestOptions<Ctx>,
) => Effect.Effect<A, UpstreamError>;

export function makeRequester<Ctx = undefined>(config: HttpConfig<Ctx>): Requester<Ctx> {
  const rateLimited = new Set(config.rateLimitedStatuses ?? DEFAULT_RATE_LIMITED);
  const classify = classifyFailure({
    upstream: config.upstream,
    override: config.classifyOverride,
  });

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

      const body = yield* Effect.tryPromise({
        try: () => res.json(),
        catch: (cause) => new HttpFailure({ kind: "parse", where, cause }),
      });

      // HTTP 200 但 body 里说不行(CEX 常见:bybit 的 retCode、okx 的 code)。
      //
      // **只在这条路上跑**,不在整个 effect 的成功通道上:上面那个 `notFoundAsNull` 的 `null`
      // 是「没有这个东西」的正常答案,不是一份 body —— 把它喂给 `checkBody` 会让读 `body.retCode`
      // 的实现当场 TypeError。`where` 也用 `pathname` 而不是入参 `path`:后者可能带 query
      // (有些上游的路径常量自带 `?ccy=USD`),而 query 里有地址和签名(原则 #5 红线)。
      const rejected = config.checkBody?.(body, where);
      if (rejected) return yield* Effect.fail(rejected);
      return body;
    });

    const gated = config.limit ? config.limit(once) : once;
    // 归类在这里做完 —— 出口就是最终错误面。`checkBody` 吐的已经是最终错误,原样放行。
    return gated.pipe(
      Effect.mapError((e) =>
        e._tag === "HttpFailure" || e._tag === "SigningFailure" ? classify(e) : e,
      ),
      Effect.map((body) => body as A),
    );
  };
}

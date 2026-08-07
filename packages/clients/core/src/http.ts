import type { HttpClientError } from "@effect/platform";
import { HttpClient, HttpClientRequest } from "@effect/platform";
import { Clock, Effect, ParseResult, type RateLimiter, Schema } from "effect";
import { HttpFailure, type SigningFailure } from "./errors";
import { disableBuiltInTracing } from "./http-client";
import { classifyFailure, type UpstreamError } from "./upstream-error";

// 一个薄的 HTTP 层:**限频 → 出网 → 归类失败**,底下是官方 `HttpClient`(见 `http-client.ts`)。
//
// 相对迁移前 `@folio/shared` 那版少了两样,都是刻意的:
//
// **不收 `retry` 选项。** 重试由调用方 `Effect.retry(策略)` 加在外面。老版把重试收进来是因为
// 「闸必须在重试里面,否则退避完立刻插队」这条语义只能由包自己保证;而 `Effect.retry` 重跑的是
// **整个 effect**,闸就在里面,每次重试自然重新排队 —— 语义自动正确,不需要包替调用方管。换来的是
// ADR 0035 想要的那件事:重试策略成为**可组合的值**,谁调谁决定,而不是每个 client 各写一份 opts。
//
// **不收 `toFailure` 回调。** 出口就是最终错误面 `UpstreamError`,不是传输层的中间态:
// `HttpFailure` / `SigningFailure` 是归类**过程**用的,没有任何一个 client 想要它们。
//
// **也不再收 `checkBody` / `classifyOverride` 两个回调。** 它们和被删掉的 `toFailure` 是同一个
// 模式 —— 配置对象上挂回调,等于把流水线的一步藏进配置里。现在:
//   · 「HTTP 200 但 body 说不行」(bybit 的 retCode、okx 的 code)由 client 自己在它那个**唯一的**
//     内部 `get()` 上 `Effect.flatMap` 一步 —— 每个端点都经过它,漏不掉,而且这一步是看得见的代码
//   · 上游特有的归类差异(binance 的 400 → 凭据问题)由 client 在出口 `Effect.catchTag` 一步
// 剩下的 `headers` 留着,但它不是配置回调:它是**真正的效应式依赖**(rabby 的 wasm 签名、
// binance 的 HMAC 会失败),形状就是官方 `mapRequestEffect` 那个形状。

// Retry-After:纯秒数 或 HTTP-date → 毫秒;缺失/无效 → undefined。
// **不导出** —— 调用方拿到的是 `UpstreamRateLimitError.retryAfterMs`,不需要自己解析头
// (迁移前仓库里有三份重复实现,正是因为每家都自己解一遍)。官方 `HttpClient` 不管这个头。
function parseRetryAfter(header: string | undefined, now: number): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : undefined;
  const at = Date.parse(header);
  if (Number.isNaN(at)) return undefined;
  const delta = at - now;
  return delta > 0 ? delta : undefined;
}

const DEFAULT_RATE_LIMITED = [429];

export interface RequestOptions {
  readonly query?: Record<string, string | number | undefined>; // undefined 的键不参与
  readonly method?: "GET" | "POST";
  // POST 的 body(已经序列化好的字符串)。**显式两个字段,不再收一个 `RequestInit`** ——
  // 后者能塞 headers,而它会和 `headers()` 算出来的头打架(以前那版就有过「写 undefined 把
  // 调用方的头静默抹掉」的 bug)。
  readonly body?: string;
  // 404 当成「没有这个东西」而不是故障 → 返回 null。只对「按 id 查一个东西」的端点开。
  readonly notFoundAsNull?: boolean;
  // 这一发的头,**覆盖** `HttpConfig.headers`。给「凭据是每请求现取的」那五家用
  // (binance / okx / bybit / zerion / coinstats:key 来自 `ctx.creds`,不是模块级常量)。
  //
  // **以前这里是一个 `context?: Ctx`**,由包递给 `config.headers(path, options)`,于是
  // `Ctx` 要穿过 `Requester` / `RequestOptions` / `HttpConfig` 三层类型,而签名器读的是
  // `options?.context`(类型上可选,实际必填 —— 两家为此各写了一句「缺凭据」的运行时检查)。
  // 现在头在**调用点**算好:那里 path、query、凭据都在手上,不必绕一圈递进来再取出去。
  readonly headers?: Effect.Effect<HeadersInit, SigningFailure>;
}

export interface HttpConfig {
  // **必填**:所有真实调用点都有基址,而少了它 `new URL("/path")` 会当场炸 —— 与其留一个
  // 「忘了传就报 Invalid URL」的失败模式,不如在类型上要求它。
  readonly baseUrl: string;
  // 这是谁。进每个错误的 `upstream` 字段和 span 的属性 —— 类型合并之后「是谁失败的」只能靠数据带。
  readonly upstream: string;
  // 每次请求的头。**是函数而不是对象** —— 签名类的头(rabby 的 wasm 签名)要按路径和参数算,
  // 而且可能失败。它的错误进错误通道,**不被归类成传输故障**:归错了会退化成「三次退避全白打」,
  // 还把真正的原因盖掉。**这一份是 client 级的**;凭据每请求不同的走 `RequestOptions.headers`。
  readonly headers?: (
    path: string,
    options: RequestOptions | undefined,
  ) => Effect.Effect<HeadersInit, SigningFailure>;
  readonly limit?: RateLimiter.RateLimiter; // 不传 = 不限频(判据见 RateLimitOptions.key 的注释:队里没人挤就别装)
  readonly rateLimitedStatuses?: readonly number[]; // 默认 [429]
}

// 出网服务 —— 每个 client 的方法签名里都会出现它(`R` 通道:「这个 effect 要有人给它出网的能力」)。
//
// **从本包再导出一次,而不是让九个包各自 `import` `@effect/platform`**:那样九份签名会写死
// 「底下是哪个 HTTP 库」,换一次库要改九个包。现在它们只认 `@folio/client-core` 的契约 ——
// 装配那头 provide 的是本包的 `FolioHttpClient`,两边都不必知道底下是谁。
export type Outbound = HttpClient.HttpClient;

// 传输层的失败 → 归类中间态。
//
// 官方把出网失败分成 `RequestError`(压根没发出去)和 `ResponseError`(发出去了但读不动),
// 而它的 `reason` 分不出我们要的那四类(「凭据被拒」和「上游 5xx」在它眼里都只是 StatusCode)——
// 状态码那部分我们自己看,这里只吃「没出去」和「读不动」两种。
//
// **`where` 由调用点给,不从 error 里抠** —— error 带的是完整 URL,而 `where` 进日志和错误消息,
// 必须只有 pathname(原则 #5 红线)。
//
// **`cause` 同理:进去的是一句摘要,不是那个错误对象。** 官方的 `RequestError` / `ResponseError`
// 上挂着 `request`,而它序列化出来是这样的:
//
//   {"cause":{"request":{"url":"…","urlParams":[["signature","s3cr3t"]],
//    "headers":{"x-mbx-apikey":"s3cr3t-key"}},"reason":"Transport"}}
//
// 也就是**签名和凭据头整个跟着错误走**。`where` 和 span 都守住了,漏的是错误对象自己。
const transportFailure =
  (where: string) =>
  (error: HttpClientError.HttpClientError): HttpFailure =>
    error._tag === "ResponseError" && error.reason === "Decode"
      ? new HttpFailure({ kind: "parse", where, cause: summarize(error) })
      : new HttpFailure({ kind: "network", where, cause: summarize(error) });

// 出网失败 → 一句能进日志的摘要。**只由本函数拼,绝不透传上游库给的对象。**
//
// 两边给的详细程度不同,理由不同:
//   · **没出去**(`RequestError`)—— 带上内层 message。内层是 fetch 抛的东西(DNS / 连不上 /
//     超时),message 里最多有主机名或 IP,而主机名本来就不是秘密(每个错误都带着 `upstream`)。
//     而「为什么没出去」是排障时唯一有用的那句
//   · **读不动**(`ResponseError`)—— **不带内层 message**,给状态码。JSON 解析失败的 message 会把
//     响应正文的一截拼进去(`Unexpected token '<', "<html>…"`),而正文是上游的数据(余额、地址)。
//     它不是凭据,但也没有理由跟着一个到处传的错误对象走
const summarize = (error: HttpClientError.HttpClientError): string => {
  if (error._tag === "ResponseError") {
    return `ResponseError/${error.reason} ${error.response.status}`;
  }
  const inner = error.cause;
  const detail = inner instanceof Error ? inner.message : undefined;
  return detail ? `RequestError/${error.reason}: ${detail}` : `RequestError/${error.reason}`;
};

// schema 校验不过 → 一句能进日志的话。**只说「哪一处、哪一类不对」,不带实际值。**
//
// `ParseError` 自带的格式化器会把**实际值拼进消息**(`Expected string, actual "0x…"`),
// 而那是上游响应的正文 —— 与 `summarize` 里那条同一个判断:正文不跟着错误到处走。
// 路径 + 类别足够定位(「第 3 行的 id 类型不对」),值去看那一发的响应。
const whyInvalid = (error: ParseResult.ParseError): string => {
  const issues = ParseResult.ArrayFormatter.formatErrorSync(error);
  const first = issues[0];
  const at = first && first.path.length > 0 ? first.path.join(".") : "(root)";
  const more = issues.length > 1 ? ` (+${issues.length - 1} more)` : "";
  return `schema: ${at} ${first?._tag ?? "Invalid"}${more}`;
};

// 发一个请求,回**校验过**的 JSON(`notFoundAsNull` 且 404 时回 null)。
//
// **错误就是 `UpstreamError`,不是传输层的中间态。** 七家各自 `Effect.mapError(classify)` 一遍
// 是同一句样板抄七份,还把「这个请求会失败成什么」的答案推迟了一层。归类是这个包的活。
//
// **schema 必填,不是可选的。** 以前这里是一个调用方声明的类型参数 + 包内一次 `as A` ——
// 也就是「返回类型是调用方说了算」,而运行时一个字段都没查。上游改个形状就是**静默故障**:
// 字段没了 → `undefined` → 解析器要么产一行垃圾要么整批消失,错误通道里什么都没有。
//
// 现在形状由 schema 说了算,返回类型从它推出来,`as A` 整个消失。校验不过 → `UpstreamParseError`
// (不可重试:再拉一次还是同一份坏形状)。
//
// **验的是「我们真读的那些字段」,不是全字段严格校验** —— 各 client 的 `types.ts` 就是那份声明,
// 逐字来自真实响应;上游多给的字段照旧放行(`Schema.Struct` 默认忽略多余键)。严格校验会让
// 上游加一个字段就整批炸,那是把一种静默故障换成一种噪音故障。
//
// **`notFoundAsNull` 进类型**:开了它返回的就是 `Effect<A | null>`,不靠调用方自己记得在类型参数
// 里写 `| null`(以前靠记,而 coingecko 那边已经在手写了 —— 代价已经在付)。
export interface Requester {
  <A, I>(
    path: string,
    schema: Schema.Schema<A, I>,
    options: RequestOptions & { readonly notFoundAsNull: true },
  ): Effect.Effect<A | null, UpstreamError, Outbound>;
  <A, I>(
    path: string,
    schema: Schema.Schema<A, I>,
    options?: RequestOptions,
  ): Effect.Effect<A, UpstreamError, Outbound>;
}

export function makeRequester(config: HttpConfig): Requester {
  const rateLimited = new Set(config.rateLimitedStatuses ?? DEFAULT_RATE_LIMITED);
  const classify = classifyFailure({ upstream: config.upstream });

  return (<A, I>(path: string, schema: Schema.Schema<A, I>, options?: RequestOptions) => {
    const url = new URL(`${config.baseUrl}${path}`);
    for (const [k, v] of Object.entries(options?.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    // **失败信息和 span 里只带 pathname,不带 query。** query 里有地址、签名这类东西,
    // 而这两个都会被人读到(原则 #5 的红线)。
    const where = url.pathname;
    const method = options?.method ?? "GET";

    const once = Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      // 每请求的头**覆盖** client 级那份 —— 两者都想设同一个 key 头时,近的那个说了算。
      const headerSource = options?.headers ?? config.headers?.(path, options);
      const headers = headerSource ? yield* headerSource : undefined;

      const request = HttpClientRequest.make(method)(url).pipe(
        headers ? HttpClientRequest.setHeaders(headers) : (r) => r,
        options?.body === undefined
          ? (r) => r
          : HttpClientRequest.bodyText(options.body, "application/json"),
      );

      const res = yield* client.execute(request).pipe(Effect.mapError(transportFailure(where)));

      if (res.status < 200 || res.status >= 300) {
        if (rateLimited.has(res.status)) {
          const now = yield* Clock.currentTimeMillis;
          return yield* new HttpFailure({
            kind: "rate-limited",
            where,
            status: res.status,
            retryAfterMs: parseRetryAfter(res.headers["retry-after"], now),
          });
        }
        if (res.status === 401 || res.status === 403) {
          return yield* new HttpFailure({ kind: "auth", where, status: res.status });
        }
        // 「这个东西不存在」对某些端点是正常答案,不是故障(比如按合约查币)。
        if (res.status === 404 && options?.notFoundAsNull) return null;
        return yield* new HttpFailure({ kind: "upstream", where, status: res.status });
      }

      const body = yield* res.json.pipe(
        // 同样只留摘要 —— `res.json` 失败给的也是 `ResponseError`,身上挂着完整 request。
        Effect.mapError(
          (error) => new HttpFailure({ kind: "parse", where, cause: summarize(error) }),
        ),
      );
      return yield* Schema.decodeUnknown(schema)(body).pipe(
        Effect.mapError(
          (error) => new HttpFailure({ kind: "parse", where, cause: whyInvalid(error) }),
        ),
      );
    }).pipe(
      // **官方内建的那个 span 在这里被关掉,换成下面我们自己的。**
      //
      // 关它的理由是原则 #5:它默认把完整 URL、query 和**全部请求头**写进属性,而我们的 query 里有
      // HMAC 签名和钱包地址、六个凭据头不在它的默认脱敏名单里(证据见 `http-client.ts`)。
      //
      // **关在这一层而不是只关在生产 layer 上**:后者只要有人 provide 了别的 `HttpClient` 就失效
      // (红线测试当场抓到过这件事)。这里是一个 `FiberRef` 的局部赋值,覆盖这个 effect 里发出的
      // 每一发,不管客户端是谁给的 —— 绕不过去,也不必每请求包一层客户端。
      disableBuiltInTracing,
      // 我们自己的 span:**属性是白名单**(上游是谁、什么方法、哪条路径)。
      // 白名单而不是黑名单 —— 上游将来加一个新属性,黑名单要跟着改,白名单不用。
      Effect.withSpan("http.client.request", {
        kind: "client",
        attributes: {
          "folio.upstream": config.upstream,
          "http.request.method": method,
          "url.path": where,
        },
      }),
    );

    const gated: Effect.Effect<unknown, HttpFailure | SigningFailure, Outbound> = config.limit
      ? config.limit(once)
      : once;
    // 归类在这里做完 —— 出口就是最终错误面。
    return gated.pipe(
      Effect.mapError(classify),
      Effect.map((body) => body as A),
    );
  }) as Requester;
}

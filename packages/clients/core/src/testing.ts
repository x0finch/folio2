import { HttpClient, HttpClientError, HttpClientResponse } from "@effect/platform";
import { Effect, Layer, type Scope, TestContext } from "effect";
import { RateLimitScopeOverride } from "./ratelimit";

// 九个 client 的测试共用的装配。**以前是九份手抄的 `withClient`**,长得几乎一样 ——
// 抄九遍的东西每一份都会慢慢长歪(实测:有几个包漏了 provide 限频档,于是偷偷跑在了另一档上,
// 而那一档的游标是模块级的、按 key 共享,测试之间会串味)。
//
// **为什么不是 `@effect/vitest`**(它有 `it.effect` / `it.scoped`,正是干这个的):版本对不上。
// 稳定版 `0.30.0` 声明只支持 `vitest ^3.2.0`(本仓是 4.x),而支持 vitest 4 的 `4.0.0-beta.x`
// 要求 `effect ^4.0.0-beta`(本仓是 3.22)。硬装是能跑(试过),但要在 `package.json` 里写一条
// 「忽略这个 peer 冲突」,而那条得一直挂到 Effect 4 稳定 + 整仓迁过去。为了省几行样板换一个
// 长期挂着的隐患,不划算 —— 真正要解决的是「抄了九遍」,不是「写法不够时髦」。

export interface Seen {
  readonly request: HttpClientRequestLike;
}

// 测试只关心这几样,不必扛整个 `HttpClientRequest` 的类型。
export interface HttpClientRequestLike {
  readonly method: string;
  readonly url: URL;
  // **读的时候大小写不敏感**(见 `caseInsensitive`)。
  readonly headers: Record<string, string>;
  readonly body: string | undefined;
}

// HTTP 头**本来就大小写不敏感**,而底层会把名字归一成小写。用一个普通对象直接暴露那份记录
// 等于让测试去迁就实现细节:`headers["X-Api-Sign"]` 明明发出去了却读到 `undefined`,
// 报错信息还完全不提大小写这回事(迁过来的时候五个用例栽在这上面)。
//
// 所以这里按头的真实语义包一层:存的是小写,读的时候也按小写找。
const caseInsensitive = (headers: Record<string, string>): Record<string, string> =>
  new Proxy(headers, {
    get: (target, key) =>
      typeof key === "string" ? target[key.toLowerCase()] : Reflect.get(target, key),
    has: (target, key) => (typeof key === "string" ? key.toLowerCase() in target : key in target),
  });

export interface HttpStub {
  readonly layer: Layer.Layer<HttpClient.HttpClient>;
  readonly calls: Seen[];
}

// 造一个假的 `HttpClient`:`reply` 收「第几发 + 这一发长什么样」,回一个 `Response`。
//
// 假的是 **`HttpClient` 服务**而不是 `globalThis.fetch` —— 换底之后出网走的是官方客户端,
// 在那一层顶替才测得到真实路径(签名头、body、中断都经过它)。
export function httpStub(
  reply: (request: HttpClientRequestLike, nth: number) => Response | Promise<Response>,
): HttpStub {
  const calls: Seen[] = [];
  const client = HttpClient.make((request, url) => {
    const seen: HttpClientRequestLike = {
      method: request.method,
      url,
      headers: caseInsensitive({ ...request.headers }),
      body:
        request.body._tag === "Uint8Array"
          ? new TextDecoder().decode(request.body.body)
          : undefined,
    };
    calls.push({ request: seen });
    // `reply` 抛出 / reject = **出不去**(DNS 挂了、连不上)。走 `tryPromise` 转成官方的
    // `RequestError` 而不是 `Effect.promise` —— 后者会把它变成 defect(不进错误通道),
    // 于是「网络失败该归成哪一类」这条根本测不到,测试只会看到一个未捕获的异常。
    return Effect.tryPromise({
      try: async () => {
        const res = await reply(seen, calls.length - 1);
        return HttpClientResponse.fromWeb(request, res);
      },
      catch: (cause) => new HttpClientError.RequestError({ request, reason: "Transport", cause }),
    });
  });
  return { layer: Layer.succeed(HttpClient.HttpClient, client), calls };
}

// JSON 响应的简写。
export const jsonResponse = (body: unknown, init?: ResponseInit): Response =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

// 测试用的装配:假出网 + **进程内的限频档** + `TestClock`。
//
// 限频档必须显式 provide 成 `memory`:默认是 `isolated`(生产的样子),而那一档的游标是模块级、
// 按 key 共享的 —— 不换档的话同一个 key 的两个测试会互相看见对方用掉的额度。
export const testLayer = (stub: HttpStub) =>
  Layer.mergeAll(
    stub.layer,
    Layer.succeed(RateLimitScopeOverride, "memory" as const),
    TestContext.TestContext,
  );

// 跑一个用了 client 的 effect。**失败时先把完整 `Cause` 打出来再抛** —— `runPromise` 默认只给一个
// `FiberFailure`,原因藏在里面;这一句把 `@effect/vitest` 唯一真正比手搓强的地方补回来。
export const runClient = <A, E>(
  stub: HttpStub,
  // `Scope` 也收:多数 client 的 `make` 要它(闸的构造绑在 scope 上),下面 `Effect.scoped` 关掉。
  effect: Effect.Effect<A, E, HttpClient.HttpClient | Scope.Scope>,
): Promise<A> =>
  effect.pipe(
    Effect.tapErrorCause((cause) => Effect.logError(cause)),
    Effect.scoped,
    Effect.provide(testLayer(stub)),
    Effect.runPromise,
  );

// 「这段代码不该经出网服务发请求」。**被调到就 die**,不是悄悄回一个空响应 ——
// 后者会让「本该走服务、结果没走」这类接线错误静默通过。
//
// 谁用:还没迁到 `@folio/client-core` 的 provider —— 它们内部直接调全局 `fetch`(测试打桩打在那儿),
// 但契约的 `R` 已经写着「可能要出网」,得有人填上这个位置。填一个会炸的,填得诚实。
export const noOutbound: Layer.Layer<HttpClient.HttpClient> = Layer.succeed(
  HttpClient.HttpClient,
  HttpClient.make(() =>
    Effect.die(
      new Error("noOutbound: this code path is not supposed to use the HttpClient service"),
    ),
  ),
);

import type { Outbound, UpstreamError } from "@folio/client-core";
import { type HttpStub, httpStub, jsonResponse, runClient } from "@folio/client-core/testing";
import { CoinGeckoClient, type CoinGeckoConfig } from "@folio/coingecko-client";
import { Duration, Effect, Fiber, TestClock } from "effect";

// 三个 adapter 的测试共用的装配。**打桩打在 `HttpClient` 服务上**(不是 `globalThis.fetch`)——
// 换底之后出网走的是官方客户端,在那一层顶替才测得到真实路径;顺带钉住 adapter 究竟问了哪个
// 端点、带了什么参数,那正是这几个文件相对 parse 的单测多出来的那一截。
//
// **跑的是 adapter 的 Effect 面,不是 `createCoinGeckoUpstream(...)` 那层 Promise 包装。**
// 这样假出网、假时钟、限频档都能 provide —— 以前这些测试得靠一个全局的「限频旁路」开关
// (`@folio/shared` 的 `bypassRateLimitsForTests`),那是它留下的最后一个全局可变状态。
// Promise 那层只有接线,由它自己那几条用例覆盖。

export interface Call {
  readonly path: string;
  readonly query: URLSearchParams;
}

export interface Stub {
  readonly http: HttpStub;
  readonly calls: Call[];
}

// `reply` 回响应体;两个例外:
//   · 回 `Error` 是哨兵 —— message 就是想要的状态码(默认 429)
//   · 回 `Response` 就原样发出去(要带 header 的用它,如 `Retry-After`)
export const stubbing = (reply: (call: Call, nth: number) => unknown): Stub => {
  const calls: Call[] = [];
  const http = httpStub((request, nth) => {
    const call: Call = { path: request.url.pathname, query: request.url.searchParams };
    calls.push(call);
    const body = reply(call, nth);
    if (body instanceof Response) return body;
    if (body instanceof Error) return new Response(null, { status: Number(body.message) || 429 });
    return jsonResponse(body);
  });
  return { http, calls };
};

// 按路径片段路由。键是路径的一段;值是响应体,或返回响应体的函数(每发都调一次)。
export const routed = (routes: Record<string, unknown>): Stub =>
  stubbing((call) => {
    const key = Object.keys(routes).find((k) => call.path.includes(k));
    if (key === undefined) throw new Error(`未打桩的端点: ${call.path}`);
    const hit = routes[key];
    return typeof hit === "function" ? (hit as () => unknown)() : hit;
  });

// 限频档传 **`none`**:这几个文件测的不是限频,而一个用例常常连着打十几发(翻页、分块)——
// `memory` 档会在突发额度用完后停下来等,而 `TestClock` 不会自己走,于是测试挂死。
// 闸本身由 `@folio/client-core` 的单测负责。
const provide = <A, E>(
  effect: Effect.Effect<A, E, CoinGeckoClient | Outbound>,
  config: CoinGeckoConfig,
) => Effect.provide(effect, CoinGeckoClient.layer(config));

export const run = <A, E>(
  stub: Stub,
  effect: Effect.Effect<A, E, CoinGeckoClient | Outbound>,
  config: CoinGeckoConfig = {},
): Promise<A> => runClient(stub.http, provide(effect, config), "none");

// 带重试的用例要推时钟:重试之间会 `Effect.sleep`,而 `TestClock` 不会自己走 —— 不推就永远等下去。
// 起一个 fiber 跑,然后反复「让出 + 推一秒」直到它跑完。**不断言墙钟**(CODING.md),
// 断言的是发了几次。
export const runDriven = <A, E>(
  stub: Stub,
  effect: Effect.Effect<A, E, CoinGeckoClient | Outbound>,
  config: CoinGeckoConfig = {},
): Promise<A> =>
  runClient(
    stub.http,
    Effect.gen(function* () {
      const fiber = yield* Effect.fork(provide(effect, config));
      for (let i = 0; i < 20; i++) {
        yield* Effect.yieldNow();
        yield* TestClock.adjust(Duration.seconds(1));
      }
      return yield* Fiber.join(fiber);
    }),
    "none",
  );

// 失败路径:拿到的是错误值本身(而不是一个 `FiberFailure`)。
export const failing = (
  stub: Stub,
  effect: Effect.Effect<unknown, UpstreamError, CoinGeckoClient | Outbound>,
  config: CoinGeckoConfig = {},
): Promise<UpstreamError> => run(stub, Effect.flip(effect), config);

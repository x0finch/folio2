import { FetchHttpClient, HttpClient } from "@effect/platform";
import { Effect, type Layer } from "effect";
import { constTrue } from "effect/Function";

// 出网用的 HTTP 客户端 —— **官方 `@effect/platform` 的 `HttpClient`**。
//
// 为什么用官方的而不是自己包 fetch(这个包以前就是自己包的):
//   · **中断能真的 abort** —— 它内建 `AbortController`,effect 被中断时调 `controller.abort()`。
//     手搓 `Effect.tryPromise` 收不到 signal,上层 `@folio/sync` 的超时一到只是「停止等待」,
//     请求还在飞、上游的额度照扣
//   · **客户端是个值,变换用 pipe** —— `mapRequestEffect` / `transform` / `filterStatusOk` 这些
//     组合子现成的。手搓那版想加一层(签名、埋点)只能往配置对象上再挂一个回调字段,
//     挂到第三个的时候就和「配置驱动」没区别了
//   · **将来上 schema 校验是接上去而不是造出来** —— `HttpClientResponse.schemaBodyJson`
//     (ADR 0035 把这一步推到 connectors)
//
// 代价实测过:相对裸 effect 多 33 KB gzip,而它那三个运行时依赖(msgpackr / multipasta /
// find-my-way-ts,都属于服务端 HTTP 那半边)在只用 HttpClient 时被打包器完全摇掉。

// 关掉官方内建的 tracing。
//
// **为什么必须关**:那个 span 默认往属性里写三样违反原则 #5 的东西 ——
//
//   1. `url.full` 和 `url.query` —— 我们的 query 里有 **binance 的 HMAC 签名**、
//      rabby / zerion 的**钱包地址**
//   2. **全部请求头**,而默认脱敏名单只有 `["authorization","cookie","set-cookie","x-api-key"]` ——
//      `X-MBX-APIKEY` / `x-cg-*-api-key` / `OK-ACCESS-KEY` / `OK-ACCESS-SIGN` / `X-BAPI-API-KEY` /
//      `X-BAPI-SIGN` 六个头一个都不在里面,会明文进 trace
//   3. `traceparent` 头会被**注入到出站请求里** —— 等于把我们的内部 trace id 发给币安
//
// **为什么是给 `FiberRef` 赋值,而不是把客户端包一层**:包客户端要么写在装配处 —— 那样只要有人
// provide 了别的 `HttpClient` 就失效(第一版就是这么写的,红线测试当场打回);要么每请求现包一个
// 客户端对象 —— 白付一次分配。赋 FiberRef 覆盖的是「这段 effect 里发出的每一发」,
// **与客户端从哪来无关**,绕不过去。
//
// 关掉之后 AbortController 那条**不受影响**:读过 `internal/httpClient.js`,tracerDisabled 的
// 早退分支照样把 `controller.signal` 递给 fetch、照样在中断时 abort。要的能力一个没丢。
//
// span 我们在 `makeRequester` 里自己加,属性走白名单(upstream / method / pathname)——
// **白名单而不是黑名单**:上游将来加一个新属性,黑名单要跟着改,白名单不用。
export const disableBuiltInTracing = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.locally(effect, HttpClient.currentTracerDisabledWhen, constTrue);

// 生产用的出网层。**加固不在这里**(见上:写在装配处的加固可以被绕过),这里就是官方的 fetch 实现。
// 留一个具名出口是为了给装配那头一个稳定的名字:`Effect.provide(FolioHttpClient)`,
// 而不必知道底下是 `FetchHttpClient` 还是别的什么。测试 provide 一个假的顶替(见 `./testing`)。
export const FolioHttpClient: Layer.Layer<HttpClient.HttpClient> = FetchHttpClient.layer;

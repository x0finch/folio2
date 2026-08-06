// @folio/client-core —— 上游 client 共用的 Effect 传输层:限频 → 出网 → 归类失败,加 HMAC。
//
// 为什么共享(ADR 0036):`packages/clients/*` 下 7 个 client 全要发请求、4 个要限频,各写一份就是
// 七份几乎一样的 `ensureOk`。
//
// **为什么是新包而不是往 `@folio/shared` 加:本包是它的继任者,不是它的邻居。** `@folio/shared`
// 整个包就是那套手搓传输层(`http` / `retry` / `ratelimit` / `types`,对外 5 个导出),#362 第 3 站
// 是**整包退场**而非「删掉一部分」。清掉它的前置条件已查清(见 #376):7 个老 provider、
// `apps/web` 的 `withRetry`、`clients/blockbook`、`clients/coingecko` —— 最后那个服务 oracle,
// 是它最后一个消费者。
//
// 迁移期两套并存,但**不共存于一个包**:`defineRateLimit` / `RateLimiter` / `SlotStore` /
// `RateLimitOptions` 这几个名字手搓版全占着,而内部包是单一出口(`"." : "./src/index.ts"`)——
// 塞进去要么给新的起丑名字、要么改 exports 结构,都是为了一个即将整包删掉的包改结构。
// 另外 `@folio/shared` 现在不依赖 `effect`,而它被 9 个老 provider 依赖。
//
// 名字:`shared` 比 `client-core` 好。等第 3 站删掉老包,那时只有 `clients/*` 引本包,改名成本近零。
//
// **不引入 `@effect/platform`**:它的 `HttpClient` 能替掉这里的出网那一层,但我们的需求很薄
// (GET/POST JSON + 五种归类 + Retry-After),而它的 retry / 中间件用 `Effect.retry` + `Schedule`
// 已经有了。ADR 0035 把 Effect 定为「一次性门票」,再加一张票过不了原则 #9 的「复杂度值不值」那关。

export { hmacSha256 } from "./crypto";
export { HttpFailure, type HttpFailureKind, SigningFailure } from "./errors";
export { type HttpConfig, makeRequester, type Requester, type RequestOptions } from "./http";
export { make as makeRateLimit, type RateLimitOptions, type RateLimitScope } from "./ratelimit";
export { SLOT_URL_PREFIX, type SlotCache, SlotCacheOverride } from "./slot-cursor";

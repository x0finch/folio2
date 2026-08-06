// @folio/client-core —— 上游 client 共用的 Effect 传输层:限频 → 出网 → 归类失败,加 HMAC。
//
// 为什么单独一个包(ADR 0036):`packages/clients/*` 下 7 个 client 全要发请求、4 个要限频,
// 各写一份就是七份几乎一样的 `ensureOk`。而它**不能放 `@folio/shared`** —— 那里的手搓版
// (`createHttpClient` / `withRetry` / `defineRateLimit`)还在服务老 provider 与加账户探活,本批
// 承诺「一行老代码都不改」。等 #362 第 3 站把手搓版删掉,再决定这两处是否合并。
//
// **不引入 `@effect/platform`**:它的 `HttpClient` 能替掉这里的出网那一层,但我们的需求很薄
// (GET/POST JSON + 五种归类 + Retry-After),而它的 retry / 中间件用 `Effect.retry` + `Schedule`
// 已经有了。ADR 0035 把 Effect 定为「一次性门票」,再加一张票过不了原则 #9 的「复杂度值不值」那关。

export { hmacSha256 } from "./crypto";
export { HttpFailure, type HttpFailureKind, SigningFailure } from "./errors";
export {
  type HttpConfig,
  makeRequester,
  type Requester,
  type RequestOptions,
} from "./http";
export { defineRateLimit, type RateLimiter, type RateLimitOptions } from "./ratelimit";
export {
  CacheSlotStore,
  MemorySlotStore,
  resetSlotStoresForTests,
  type SlotStore,
  type StoreChoice,
} from "./slot-store";

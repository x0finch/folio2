// @folio/client-core —— 上游 client 共用的 Effect 传输层:限频 → 出网 → 归类失败,加 HMAC,
// 外加**所有 client 共用的错误面**(四类 `Upstream*Error`)。
//
// 错误面为什么在这:那四类的划分依据是「消费者要区分什么」,而消费者(适配层)对七个上游是同一个 ——
// 各定一套就是 7 套同构错误类 + 适配层 7 份几乎一样的映射。上游之间真正的差别(binance 用 400
// 表达签名被拒)由 `classifyFailure` 的 `override` 吃掉,一家一条。
//
// **重试策略不在这。** 重试归 `@folio/sync`(`src/retry.ts`,已是 Effect `Schedule`):它包的是
// 「取一次余额」整件事、含超时,而不是「打一个 HTTP 请求」——两层各退避 3 次就是 9 次。
// client 这一层只负责把错误分对类,让上面那份策略读得懂。
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
// **出网走 `@effect/platform` 的 `HttpClient`**(推翻了本文件早先「不引入」的判断)。当时的理由是
// 「需求很薄,再加一张票过不了原则 #9」——薄这一点判错了:手搓那版的 `Effect.tryPromise` 收不到
// `AbortSignal`,上层超时之后请求还在飞、额度照扣,而这是自己包 fetch 修不掉的(signal 得由发请求
// 的那一层持有)。官方客户端内建 AbortController、内建中断即 abort,还顺带把「加一层」从
// 「往配置对象上挂第 N 个回调」变成 `pipe`。体积实测 +33 KB gzip(它那三个服务端依赖被完全摇掉)。
//
// **但它的内建 tracing 必须关掉** —— 默认会把完整 URL、query 和全部请求头写进 span,而我们的 query
// 里有 HMAC 签名和钱包地址、六个凭据头不在它的默认脱敏名单里。span 我们自己加,只写白名单属性。
// 理由和证据见 `http-client.ts`。

export { hmacSha256 } from "./crypto";
export { HttpFailure, type HttpFailureKind, SigningFailure } from "./errors";
export {
  type HttpConfig,
  makeRequester,
  type Outbound,
  type Requester,
  type RequestOptions,
} from "./http";
export { FolioHttpClient } from "./http-client";
export {
  make as makeRateLimit,
  type RateLimitOptions,
  type RateLimitScope,
  RateLimitScopeOverride,
} from "./ratelimit";
export { SLOT_URL_PREFIX, type SlotCache, SlotCacheOverride } from "./slot-cursor";
export {
  type StaleTolerantCache,
  type StaleTolerantCacheOptions,
  staleTolerantCache,
} from "./stale-cache";
export {
  type ClassifyOptions,
  classifyFailure,
  UpstreamAuthError,
  type UpstreamError,
  UpstreamParseError,
  UpstreamRateLimitError,
  UpstreamUnavailableError,
} from "./upstream-error";

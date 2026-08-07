import { Data } from "effect";

// 出网失败的**归类结果**,不是任何 client 的最终错误类型。
//
// 与迁移前 `@folio/shared` 那版的关键区别:那版让调用方传一个 `toFailure` 回调进来,由包在
// 归类点调用它、抛出调用方的错误类;这里 HTTP 层只吐 `HttpFailure`,调用方在**错误通道上**
// 用 `Effect.mapError` 转成自己的类型。
//
// 为什么改:回调那种写法下,「这个请求会失败成什么」不在类型里 —— `Fetcher` 的返回类型是
// `Promise<unknown>`,错误类型只存在于 `toFailure` 的实现里,编译器管不着。改成错误通道之后
// `Effect<A, HttpFailure>` 把它写进签名,谁忘了映射就是编译错误。
export type HttpFailureKind =
  | "network" // 压根没出去(DNS / 断网 / fetch 抛了)
  | "rate-limited" // 被限流(默认 429;binance 还要认 418)
  | "auth" // 401 / 403,凭据被拒
  | "upstream" // 其余非 2xx
  | "parse"; // 出去了、回来了,但读不成 JSON

export class HttpFailure extends Data.TaggedError("HttpFailure")<{
  readonly kind: HttpFailureKind;
  // 出事的**路径**(pathname)。**刻意不带 query** —— 那里面有地址、签名这类东西,
  // 而这个对象会进错误消息和日志(原则 #5 的红线)。
  readonly where: string;
  readonly status?: number;
  readonly retryAfterMs?: number; // 上游 Retry-After 头解析出来的(秒数或 HTTP-date 都认)
  readonly cause?: unknown;
}> {}

// 签名 / 摘要算不出来。**不是传输故障** —— 归到网络类会让它吃三次退避全白打,还把真正的原因盖掉
// (rabby 的 wasm 签名、binance 的 HMAC 都可能在这里失败)。调用方通常映射成「凭据问题」。
export class SigningFailure extends Data.TaggedError("SigningFailure")<{
  readonly where: string;
  readonly cause?: unknown;
}> {}

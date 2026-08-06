import { type HttpFailure, SigningFailure } from "@folio/client-core";
import { Data } from "effect";
import { SIGNED_REQUEST_REJECTED_STATUS } from "./constants";

// Binance client 的错误面。
//
// **相对老 provider 的 `ProviderError` 是重新设计,不是换个类名**:老那版是一个类 + 六个 `code`
// 字符串 + 一个 `retryable` 布尔,重试判据靠读那个布尔(鸭子类型)。这里改成**四个 tagged error,
// 「能不能重试」由类型本身表达** —— 分类的依据是「消费者要区分什么」,不是「HTTP 状态码有几种」:
//
//   · `BinanceAuthError`      凭据问题 —— 重试没用,拿错凭据再打还会被当探测行为
//   · `BinanceRateLimitError` 被限流 —— 重试有用,而且上游可能给了该等多久
//   · `BinanceUpstreamError`  够不到上游 / 5xx —— 重试有用
//   · `BinanceParseError`     响应读不动 —— 重试没用
//
// 好处是调用方 `catchTag` 有穷尽检查,而不是 `if (err.retryable)` 这种编译器管不着的判断;
// 少一个「构造时忘传 retryable」的失败模式。

export class BinanceAuthError extends Data.TaggedError("BinanceAuthError")<{
  readonly where: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class BinanceRateLimitError extends Data.TaggedError("BinanceRateLimitError")<{
  readonly where: string;
  readonly status?: number;
  readonly retryAfterMs?: number; // 上游 Retry-After 给的建议等待,重试方优先采用
}> {}

export class BinanceUpstreamError extends Data.TaggedError("BinanceUpstreamError")<{
  readonly where: string;
  readonly status?: number;
  readonly cause?: unknown;
}> {}

export class BinanceParseError extends Data.TaggedError("BinanceParseError")<{
  readonly where: string;
  readonly cause?: unknown;
}> {}

export type BinanceError =
  | BinanceAuthError
  | BinanceRateLimitError
  | BinanceUpstreamError
  | BinanceParseError;

// 传输层的归类结果 → binance 的错误面。归类规则与老 provider 的 `toFailure` **逐条一致**:
//
//   · 签不出来(`SigningFailure`)→ 凭据问题。secret 非法才会走到这,不是传输故障 —— 归到网络类
//     会让它吃三次退避全白打,还把真正的原因盖掉
//   · **HTTP 400 → 凭据问题,不可重试。** binance 用 400 表达「这份签名请求被拒」,最常见的是错
//     secret(签名对不上,-1022)或 key 格式非法(-2014)。重试没用,还会拿着错凭据再打一次上游 ——
//     binance 会把重复认证失败当探测行为(#240)。极少数非凭据 400(如 -1021 时钟偏移)也归此:
//     同样非瞬时,且与迁移前行为一致
//   · 401 / 403 → 凭据被拒
//   · 429 / 418 → 限流(418 = 收到 429 还继续打换来的封 IP,同类处理)
//   · 读不成 JSON → parse
//   · 其余(含压根没出去)→ upstream
export function fromTransportFailure(failure: HttpFailure | SigningFailure): BinanceError {
  if (failure instanceof SigningFailure) {
    return new BinanceAuthError({ where: failure.where, cause: failure.cause });
  }
  const { kind, where, status, retryAfterMs, cause } = failure;
  if (kind === "auth" || status === SIGNED_REQUEST_REJECTED_STATUS) {
    return new BinanceAuthError({ where, status, cause });
  }
  if (kind === "rate-limited") return new BinanceRateLimitError({ where, status, retryAfterMs });
  if (kind === "parse") return new BinanceParseError({ where, cause });
  return new BinanceUpstreamError({ where, status, cause });
}

// 「这个错误值得再打一次吗」。**判据在类型里,这个函数只是把它写成一处** ——
// 调用方也可以直接 `catchTags`,两种都行;需要喂给 `Schedule.whileInput` 时用这个更省事。
export function isRetryable(error: BinanceError): boolean {
  return error._tag === "BinanceRateLimitError" || error._tag === "BinanceUpstreamError";
}

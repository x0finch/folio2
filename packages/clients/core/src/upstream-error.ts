import { Data, Match } from "effect";
import type { HttpFailure, SigningFailure } from "./errors";

// **所有 client 共用的对外错误面。**
//
// 为什么在 core 而不是每个 client 各定一套:这四类的划分依据是**「消费者要区分什么」**,而消费者
// (适配层)对七个上游是同一个 —— 它要做的判断永远是这四个:换凭据 / 等一会儿再来 / 上游的锅 /
// 上游变了形状。上游之间的差别不在**分成哪几类**,而在**怎么归类**(binance 用 400 表达签名被拒,
// 别家不是),那部分由下面的 `override` 吃掉。
//
// 各定一套的代价是实打实的:7 套同构的错误类 + 7 份 `isRetryable` + 适配层 7 份几乎一样的映射,
// 正是 ADR 0036 要消掉的那种重复,只是换了个地方长出来。
//
// **不是鸭子类型**:老 `@folio/shared` 靠读 `err.retryable` 布尔(谁都能忘了传),这里判据是
// `_tag`,`catchTag` 有穷尽检查,构造时也没有能忘的字段。
//
// `upstream` 字段留着答「是谁失败的」—— 类型合并之后这条信息只能靠数据带,而它进日志和 UI 文案。

interface Common {
  readonly upstream: string; // "binance" / "okx" / …
  readonly where: string; // 出事的 pathname。**刻意不带 query**(原则 #5 红线)
  readonly status?: number;
  // **一句摘要,不是错误对象**(同 `HttpFailure.cause`,理由见那里)。类型钉成 `string`,
  // 所以「顺手把上游库的错误对象透传下来」是编译错误 —— 而那正是签名和 API key 泄出去的路径。
  readonly cause?: string;
}

// 凭据问题 —— 重试没用,换凭据才行。
export class UpstreamAuthError extends Data.TaggedError("UpstreamAuthError")<Common> {}

// 被限流 —— 等一会儿再来。`retryAfterMs` 是上游给的建议,重试方优先采用。
export class UpstreamRateLimitError extends Data.TaggedError("UpstreamRateLimitError")<
  Common & { readonly retryAfterMs?: number }
> {}

// 够不到上游 / 5xx —— 上游的锅,重试有用。
export class UpstreamUnavailableError extends Data.TaggedError(
  "UpstreamUnavailableError",
)<Common> {}

// 响应读不动 —— 上游变了形状,再读一次还是读不动。
export class UpstreamParseError extends Data.TaggedError("UpstreamParseError")<Common> {}

export type UpstreamError =
  | UpstreamAuthError
  | UpstreamRateLimitError
  | UpstreamUnavailableError
  | UpstreamParseError;

// 「这个错误值不值得再打一发」。**判据是 `_tag`,住在错误面自己这个文件里** —— 加一个 tag 会让
// 这里当场编译红(`Match.exhaustive`),而散在各调用点的 if 链只会悄悄漏掉新那一类。
//
// 与 `@folio/connectors-basic` 的同名函数是**两套错误各自的答案**,不是重复:那边判的是
// `ConnectorError`(适配层翻译之后的),这边判的是 client 直接吐出来的四类。
// 消费者是谁决定用哪个 —— 适配层用那边的,直接拿 client 说话的(如 oracle 的 CoinGecko adapter)用这边的。
export const isRetryable: (error: UpstreamError) => boolean = Match.type<UpstreamError>().pipe(
  Match.tag("UpstreamRateLimitError", "UpstreamUnavailableError", () => true),
  // 凭据不对 / 上游变了形状 —— 再打一发还是同一个答案。
  Match.tag("UpstreamAuthError", "UpstreamParseError", () => false),
  Match.exhaustive,
);

// 上游建议的等待时长(只有被限流那一类给得出)。重试策略优先采用它。
export const retryAfterOf = (error: UpstreamError): number | undefined =>
  error._tag === "UpstreamRateLimitError" ? error.retryAfterMs : undefined;

export interface ClassifyOptions {
  readonly upstream: string;
}

// 传输层的归类结果 → 对外错误面。
//
// 分派走 `Match` 的 `_tag` / 穷尽检查:传输层将来加一种 `HttpFailureKind` 时这里会当场编译红,
// 而 if 链只会悄悄落到最后那个「其余算上游的锅」。
// **上游特有的归类差异不在这里,在调用点。** binance 用 HTTP 400 表达「这份签名请求被拒」,
// 那一条由 binance 自己在出口 `Effect.catchTag("UpstreamUnavailableError", …)` 改判 —— 一家一行,
// 看得见。以前它是 `ClassifyOptions.override` 一个配置回调,和被删掉的 `toFailure` 同一个毛病:
// 把流水线上的一步藏进配置对象里。
export const classifyFailure =
  (options: ClassifyOptions) =>
  (failure: HttpFailure | SigningFailure): UpstreamError => {
    const { upstream } = options;
    // 签不出来。**不是传输故障** —— 归到网络类会让它吃满退避全白打,还把真正的原因盖掉
    // (rabby 的 wasm 签名、binance 的 HMAC 都可能在这里失败)。
    //
    // 判 `_tag` 不判 `instanceof`:两边都是 tagged error,而 `instanceof` 还额外要求两个类
    // 来自同一个模块实例 —— 那是包管理器的事,不该是这段代码正确性的前提。
    if (failure._tag === "SigningFailure") {
      return new UpstreamAuthError({ upstream, where: failure.where, cause: failure.cause });
    }

    const { where, status, retryAfterMs, cause } = failure;
    const base = { upstream, where, status, cause };
    return Match.value(failure.kind).pipe(
      Match.when("auth", () => new UpstreamAuthError(base)),
      Match.when(
        "rate-limited",
        () => new UpstreamRateLimitError({ upstream, where, status, retryAfterMs }),
      ),
      Match.when("parse", () => new UpstreamParseError(base)),
      // 压根没出去 与 其余非 2xx —— 对消费者是同一件事:够不到上游,重试有用。
      Match.whenOr("network", "upstream", () => new UpstreamUnavailableError(base)),
      Match.exhaustive,
    );
  };

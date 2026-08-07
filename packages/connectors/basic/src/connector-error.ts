import { Data, Match } from "effect";
import { ProviderError } from "./errors";

// 【connector 操作的失败面】—— Effect 迁移(ADR 0035 / 0036)。
//
// **划分依据是「调用方要区分什么」,不是「上游有多少种毛病」。** 调用方只有两个:
// `@folio/sync` 的重试策略(重不重试、等多久)和加账户那条路(凭据不对 → 让用户改,别重试)。
// 它们要分辨的正好是下面这四类,所以就是四类 —— 上游那些更细的分法(parse / unsupported /
// 没预料到的抛出)对这两个调用方**处理方式完全一样**,合成一类不丢信息,分开只是让每个
// `catchTag` 都得多写两个分支。
//
// 与 `@folio/client-core` 的 `Upstream*Error` 是**同一套划分,不同的层**:那边答「一个 HTTP 请求
// 怎么失败的」,这边答「取一个账户的余额怎么失败的」(还包括 manual 这种压根不出网的 connector)。
// B2 接线时前者映射到后者,因为形状一致,那个映射是一对一的。
//
// **不带 `retryable` 布尔**(老 `ProviderError` 有)。布尔是鸭子类型:谁都能忘了传、别处冒上来的
// 任意对象只要恰好有这个字段就会被当真。判据换成 `_tag`,`catchTag` 有穷尽检查,构造时也没有
// 能忘的字段。「哪些值得重试」由下面的 `isRetryable` 一处回答。

interface Common {
  readonly message: string;
  readonly cause?: unknown;
}

// 凭据问题 —— 重试没用,换凭据才行。上游拒了(401/403/业务码),或凭据本身就不成立
// (blockbook 的 xpub 解析不出来)。`validateAccount` 认的就是它。
export class ConnectorAuthError extends Data.TaggedError("ConnectorAuthError")<Common> {}

// 被限流 —— 等一会儿再来。`retryAfterMs` 是上游给的建议,重试方优先采用。
export class ConnectorRateLimitError extends Data.TaggedError("ConnectorRateLimitError")<
  Common & { readonly retryAfterMs?: number }
> {}

// 够不到上游 / 5xx / 超时 —— 上游的锅,重试有用。
export class ConnectorUnavailableError extends Data.TaggedError(
  "ConnectorUnavailableError",
)<Common> {}

// 其余全部 —— **重试改变不了的那些**:响应形状读不懂、这个操作不支持、以及没预料到的抛出。
//
// 为什么不给它们各一个 tag:两个调用方对这三种的处理**一字不差**(不重试、记一笔、这个账户算失败)。
// 分开只会让每处 `catchTag` 多两个长得一样的分支,而真正的差别本来就在 `message` 里。
export class ConnectorFailure extends Data.TaggedError("ConnectorFailure")<Common> {}

export type ConnectorError =
  | ConnectorAuthError
  | ConnectorRateLimitError
  | ConnectorUnavailableError
  | ConnectorFailure;

// 「这个失败值得再打一发吗」。**收在一处**,因为有两个调用方(sync 的退避重试、加账户时的探活重试),
// 而它们必须给同一个答案。
//
// 用 `Match.exhaustive` 而不是 if 链或 Set:将来加一个 tag,这里**当场编译红**,逼着做决定 ——
// if 链只会让新 tag 悄悄落进 `else`,而那个默认值是谁都没想过的。
export const isRetryable: (error: ConnectorError) => boolean = Match.type<ConnectorError>().pipe(
  Match.tag("ConnectorRateLimitError", "ConnectorUnavailableError", () => true),
  Match.tag("ConnectorAuthError", "ConnectorFailure", () => false),
  Match.exhaustive,
);

// 上游建议的等待时长(只有限流会给)。
export const retryAfterOf = (error: ConnectorError): number | undefined =>
  error._tag === "ConnectorRateLimitError" ? error.retryAfterMs : undefined;

// ⚠️ 临时桥 —— provider 实现内部还在抛老的 `ProviderError`(60 个构造点散在 9 个包)。
// 本片只改**契约的形状**,provider 内部一个字不动,各自在出口包一层 `Effect.tryPromise` 用它接住。
//
// **B2 起各片接线时逐个去掉**(那时 provider 直接吐 `ConnectorError`),`ProviderError` 连同
// 本函数在 C 批一起删。
//
// 判据刻意保持迁移前的行为:`instanceof ProviderError` 而非鸭子类型 —— 免得别处冒上来的、
// 恰好带 `retryable: true` 的对象也被重试。**非 `ProviderError` 一律进 `ConnectorFailure`**
// (不重试):没预料到的抛出重试也是白赔,而当成可重试会让一个必然失败的账户白打三轮。
export function fromProviderError(err: unknown): ConnectorError {
  if (!(err instanceof ProviderError)) {
    return new ConnectorFailure({ message: messageOf(err), cause: err });
  }
  const fields = { message: err.message, cause: err };
  switch (err.code) {
    // 「凭据被拒」与「凭据本身不成立」老版是两个 code,但**没有一个调用方分辨它们**
    // (`CREDENTIAL_REJECTION_CODES` 把两个装在一起),所以合成一个 tag。
    case "AUTH_FAILED":
    case "INVALID_CREDENTIALS":
      return new ConnectorAuthError(fields);
    // —— 下面两类**默认可重试**,所以要看一眼有没有被显式否掉 ——
    case "RATE_LIMITED":
      return demoteIfNotRetryable(
        err,
        new ConnectorRateLimitError({ ...fields, retryAfterMs: err.retryAfterMs }),
        fields,
      );
    case "UPSTREAM_ERROR":
      return demoteIfNotRetryable(err, new ConnectorUnavailableError(fields), fields);
    // PARSE_ERROR / UNSUPPORTED —— 见 `ConnectorFailure` 的说明。
    default:
      return new ConnectorFailure(fields);
  }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// 老 `ProviderError` 允许 `retryable` 与 `code` **脱钩**,而且真有人用:blockbook 的客户端把
// 服务端永久拒(4xx,如无效 xpub 的 400)标成 `UPSTREAM_ERROR` + `retryable: false`。只按 code 归类
// 的话它会变成「够不到上游」→ 被重试,一个必然失败的 400 白打三轮。
//
// **只对本来就可重试的两类生效。** `AUTH_FAILED` 那些带不带 `retryable: false` 都一样不重试,
// 拿它当降级信号会把「凭据问题」错判成「说不清的失败」,`validateAccount` 那条路当场就不对了。
// (两条各有一个用例钉住 —— 第一版粗暴地「见 false 就降级」,binance 那条立刻红。)
function demoteIfNotRetryable(
  err: ProviderError,
  classified: ConnectorError,
  fields: { readonly message: string; readonly cause: unknown },
): ConnectorError {
  return err.retryable === false ? new ConnectorFailure(fields) : classified;
}

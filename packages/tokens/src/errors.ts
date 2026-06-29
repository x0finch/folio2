// 错误契约 —— 平行于 `@folio/core` 的 `ProviderError`(本包不依赖 core,故独立定义)。
// 纯策略(resolve)不 throw 域错误(返回 `null`/`low`);本类供 P7.2 的 `TokenSource` 实现 throw:
// CGK 429 → RATE_LIMITED(+retryAfterMs)、5xx/网络 → UPSTREAM_ERROR、坏 JSON → PARSE_ERROR。
export type TokenErrorCode = "RATE_LIMITED" | "UPSTREAM_ERROR" | "PARSE_ERROR";

export class TokenError extends Error {
  readonly code: TokenErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: TokenErrorCode,
    message: string,
    opts?: { retryable?: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "TokenError";
    this.code = code;
    this.retryable = opts?.retryable ?? code === "RATE_LIMITED";
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

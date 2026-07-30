// 统一 provider 错误类型(所有 code 具名,不散字符串)。搬自旧 @folio/balances-basic;
// @folio/sync 据 instanceof + retryable 决定重试(并存期分派桥须统一 ProviderError 身份,见 #31)。
export type ProviderErrorCode =
  | "INVALID_CREDENTIALS" // 凭据格式/字段缺失,加账户校验失败
  | "AUTH_FAILED" // 凭据被远端拒绝(签名/权限)
  | "RATE_LIMITED" // 被限流
  | "UPSTREAM_ERROR" // 远端 5xx / 网络等临时故障
  | "PARSE_ERROR" // 响应形状不符,解析失败
  | "UNSUPPORTED"; // 该 connector/操作暂不支持

// 默认可重试的 code:限流与上游临时故障。其余视为不可重试。
const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
]);

export interface ProviderErrorOptions {
  cause?: unknown;
  retryable?: boolean; // 不传则按 code 推断(见 RETRYABLE_CODES)
  retryAfterMs?: number; // 服务端 Retry-After 建议等待(毫秒),重试方优先采用
}

export class ProviderError extends Error {
  readonly code: ProviderErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(code: ProviderErrorCode, message: string, options: ProviderErrorOptions = {}) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = "ProviderError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_CODES.has(code);
    this.retryAfterMs = options.retryAfterMs;
  }
}

// 「上游拒了这份凭据」的 code。**给 `validateAccount` 用**(契约见 connector.ts):探活的 catch 里
// 用它区分两类失败 —— 凭据被拒(`AUTH_FAILED`)或凭据本身不成立(`INVALID_CREDENTIALS`,如 blockbook
// 的 xpub 解析不出来)→ 判账户不通过、返回 `false`;其余(`RATE_LIMITED` / `UPSTREAM_ERROR` /
// `PARSE_ERROR` / 非 ProviderError)都是「够不到上游 / 说不清」,让它冒出去交调用方重试。
const CREDENTIAL_REJECTION_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "AUTH_FAILED",
  "INVALID_CREDENTIALS",
]);

// validateAccount 的 catch 判据:这个错误是不是「凭据被拒/不成立」(→ false),而非传输故障(→ 抛)。
export function isCredentialRejection(err: unknown): boolean {
  return err instanceof ProviderError && CREDENTIAL_REJECTION_CODES.has(err.code);
}

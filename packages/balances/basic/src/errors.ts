// 统一 provider 错误类型。所有 code 具名,不散字符串(遵循"不硬编码")。
export type ProviderErrorCode =
  | "INVALID_CREDENTIALS" // 凭据格式/字段缺失,加账户校验失败
  | "AUTH_FAILED" // 凭据被远端拒绝(签名/权限)
  | "RATE_LIMITED" // 被限流
  | "UPSTREAM_ERROR" // 远端 5xx / 网络等临时故障
  | "PARSE_ERROR" // 响应形状不符,解析失败
  | "UNSUPPORTED"; // 该 type/操作暂不支持

// 默认可重试的 code:限流与上游临时故障。其余视为不可重试。
const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
]);

export interface ProviderErrorOptions {
  cause?: unknown;
  retryable?: boolean; // 不传则按 code 推断(见 RETRYABLE_CODES)
  // 服务端 Retry-After 解析所得的建议等待时长(毫秒);重试方优先采用它(见 @folio/sync withRetry)。
  retryAfterMs?: number;
}

// 解析 HTTP `Retry-After` 头 → 毫秒。数字 = 秒;HTTP-date = 距现在的毫秒。无效/非正 → undefined。
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return secs > 0 ? secs * 1000 : undefined;
  const whenMs = Date.parse(header);
  if (Number.isNaN(whenMs)) return undefined;
  const delta = whenMs - Date.now();
  return delta > 0 ? delta : undefined;
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

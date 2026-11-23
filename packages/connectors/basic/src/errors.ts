export type ProviderErrorCode =
  | "INVALID_CREDENTIALS" // malformed or missing fields
  | "AUTH_FAILED" // rejected by the upstream
  | "RATE_LIMITED"
  | "UPSTREAM_ERROR" // 5xx / network
  | "PARSE_ERROR"
  | "UNSUPPORTED";

const RETRYABLE_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "RATE_LIMITED",
  "UPSTREAM_ERROR",
]);

export interface ProviderErrorOptions {
  cause?: unknown;
  retryable?: boolean; // defaults from the code
  retryAfterMs?: number;
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

const CREDENTIAL_REJECTION_CODES: ReadonlySet<ProviderErrorCode> = new Set<ProviderErrorCode>([
  "AUTH_FAILED",
  "INVALID_CREDENTIALS",
]);

// For `validateAccount`: rejected or malformed creds → `false`; anything else should propagate so
// the caller can retry.
export function isCredentialRejection(err: unknown): boolean {
  return err instanceof ProviderError && CREDENTIAL_REJECTION_CODES.has(err.code);
}

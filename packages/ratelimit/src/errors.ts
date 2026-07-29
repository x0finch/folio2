// 闸在冷却期内拒绝放行时抛的错。字段名**刻意**跟仓库里那四个错误类
// (ProviderError / CoinGeckoError / TokenError / blockbook 的)对齐 —— 于是 withRetry 的鸭子
// 类型判据认得它,不需要任何映射。
//
// 调用方想抛自己的类型就传 `onCooldown`(见 LimitPolicy):provider 对 sync 的契约是「失败一律
// ProviderError」,那一行钩子就够把冷却接进它们各自的错误体系,而本包不必认识任何外部类型。
export class RateLimitedError extends Error {
  readonly code = "RATE_LIMITED";
  readonly retryable = true;
  readonly retryAfterMs: number;

  constructor(key: string, retryAfterMs: number) {
    super(`rate limit cooling down for ${key} (${retryAfterMs}ms left)`);
    this.name = "RateLimitedError";
    this.retryAfterMs = retryAfterMs;
  }
}

// @folio/balances-basic —— 余额侧地基契约:provider 接口 + 类型 + 校验/加密原语。
// creds 的存储塑形(seal/open/safeView/isComplete)不在此 —— 归业务层(app lib/creds.ts),靠字段 schema 驱动。

export { CryptoError, decrypt, encrypt, generateSecret, hmacSha256 } from "./crypto";
export type { ProviderErrorCode, ProviderErrorOptions } from "./errors";
export { ProviderError, parseRetryAfter } from "./errors";
export {
  CredentialValidationError,
  maskCredential,
  publicKeys,
  secretKeys,
  semiKeys,
  validateCredentials,
} from "./inputs";
export type {
  BalanceProvider,
  CredsOf,
  FetchContext,
  ProviderInput,
  ProviderInputType,
} from "./provider";
export { defineProvider } from "./provider";
export type {
  Account,
  AccountType,
  AssetSnapshot,
  Balance,
  BalanceKind,
  DefiMeta,
  PerpEquityMeta,
  PerpMeta,
  PerpPositionMeta,
} from "./types";

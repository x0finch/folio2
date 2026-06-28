// @folio/core —— 全项目地基契约。只定类型与接口/纯逻辑,不含业务实现。

export { isComplete, openCreds, SEMI_PREFIX, safeView, sealCreds } from "./creds";
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
export type { ProviderRegistry } from "./registry";
export { buildRegistry, getProvider } from "./registry";
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

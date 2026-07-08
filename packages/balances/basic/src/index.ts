// @folio/balances-basic —— 余额侧地基契约:provider 接口 + 类型 + 校验/加密原语。
// creds 的存储塑形(seal/open/safeView/isComplete)不在此 —— 归业务层(app lib/creds.ts),靠字段 schema 驱动。

// 代币标识构造:唯一实现在 @folio/tokens-basic(代币身份是参考层的领域核心);此处 re-export 供 providers 用。
export { buildTokenKey, type TokenKeyInput } from "@folio/tokens-basic";
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
export type { ProviderEntry, ProviderManifest } from "./manifest";
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
  BitcoinAddress,
  BitcoinMeta,
  BitcoinReceive,
  DefiMeta,
  PerpEquityMeta,
  PerpMeta,
  PerpPositionMeta,
} from "./types";

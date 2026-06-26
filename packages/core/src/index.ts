// @folio/core —— 全项目地基契约。只定类型与接口/纯逻辑,不含业务实现。

export { CryptoError, decrypt, encrypt, generateSecret } from "./crypto";
export type { ProviderErrorCode, ProviderErrorOptions } from "./errors";
export { ProviderError } from "./errors";
export type { BalanceProvider, CredentialFlags, ProviderCredentials } from "./provider";
export type { ProviderRegistry } from "./registry";
export { buildRegistry, getProvider } from "./registry";
export type {
  Account,
  AccountType,
  AccountWithFlags,
  AssetSnapshot,
  Balance,
  BalanceKind,
} from "./types";

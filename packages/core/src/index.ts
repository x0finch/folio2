// @folio/core —— 全项目地基契约。只定类型与接口/纯逻辑,不含业务实现。
export type {
  AccountType,
  Account,
  AccountWithFlags,
  Balance,
  BalanceKind,
  AssetSnapshot,
} from "./types";

export type { ProviderCredentials, CredentialFlags, BalanceProvider } from "./provider";

export type { ProviderRegistry } from "./registry";
export { buildRegistry, getProvider } from "./registry";

export type { ProviderErrorCode, ProviderErrorOptions } from "./errors";
export { ProviderError } from "./errors";

export { encrypt, decrypt, generateSecret, CryptoError } from "./crypto";

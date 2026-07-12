// @folio/oracle-basic —— 代币参考层的契约与数据:类型 + 契约接口(TokenProvider / TokenStore)+ errors + ref
// + 常量。无逻辑函数——符号消歧策略 / 解析 / 预热服务在 @folio/oracle(entry)。
// provider 实现(@folio/oracle-provider-coingecko)依赖本包的契约面。

export type { TokenGroupDef, TokenGroupKey } from "./constants";
export {
  CGK_RECHECK_TTL_MS,
  DEFAULT_TOP_N,
  GROUP_MEMBERSHIP,
  INFO_TTL_MS,
  OVERRIDES,
  PRICE_TTL_MS,
  RESOLUTION_DOMINANCE,
  RESOLUTION_TOP_RANK,
  TOKEN_GROUPS,
  TOKEN_KEY_TTL_MS,
  TOP_TOKENS_LIMIT,
  WARM_TTL_MS,
} from "./constants";
export type { TokenErrorCode } from "./errors";
export { TokenError } from "./errors";
// 展示币种 + 汇率契约(存 USD、展示层换算;折入自 @folio/fx,#72)。
export {
  type Currency,
  DEFAULT_CURRENCY,
  FxError,
  type FxErrorCode,
  type FxRates,
  type FxRow,
  type FxSource,
  type FxStore,
  SUPPORTED_CURRENCIES,
} from "./fx";
// 平台元数据契约(链 ∪ 场馆 name+logo;折入自 @folio/platforms,#72)。
export {
  PlatformError,
  type PlatformErrorCode,
  type PlatformMeta,
  type PlatformRow,
  type PlatformSource,
  type PlatformStore,
  type Platforms,
} from "./platform";
export type { TokenProvider } from "./provider";
export { parseRefKey, refKey } from "./ref";
export type { TokenStore } from "./store";
export {
  buildTokenKey,
  type ParsedTokenKey,
  parseTokenKey,
  type TokenKeyInput,
} from "./token-key";
export type {
  AssetRef,
  CgkCoinId,
  Confidence,
  ProviderTokenSeed,
  Resolution,
  ResolutionVia,
  TokenCandidate,
  TokenGroup,
  TokenInfo,
  TokenPrice,
  TokenRecord,
  TokenRecordPrice,
  TokenRef,
} from "./types";
export type { OracleCapability, OracleVendor } from "./vendor";

// @folio/oracle-basic —— 代币参考层的契约与数据:类型 + 契约接口(TokenSource / TokenStore)+ errors + ref
// + 常量。无逻辑函数——符号消歧策略 / 解析 / 预热服务在 @folio/oracle(entry)。
// source 实现(@folio/oracle-source-coingecko)依赖本包的契约面。

export type { TokenGroupDef, TokenGroupKey } from "./constants";
export {
  CGK_RECHECK_TTL_MS,
  DEFAULT_TOP_N,
  dayBucketOf,
  GROUP_MEMBERSHIP,
  INFO_TTL_MS,
  MS_PER_DAY,
  OVERRIDES,
  PRICE_TTL_MS,
  RESOLUTION_DOMINANCE,
  RESOLUTION_TOP_RANK,
  TOKEN_GROUPS,
  TOKEN_REF_TTL_MS,
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
export type { TokenPriceHistoryStore, TokenStore } from "./store";
export type { PriceSource, TokenMetaSource, TokenSource } from "./token";
export type {
  AssetRef,
  Confidence,
  ProviderTokenSeed,
  Resolution,
  ResolutionVia,
  ResolvableAsset,
  TokenCandidate,
  TokenGroup,
  TokenInfo,
  TokenPrice,
  TokenPricePoint,
  TokenRecord,
  TokenRecordPrice,
  // tokenRef 串即参考层的解析身份(ADR 0020),源头在 @folio/oracle-ref,此处透出。
  TokenRef,
} from "./types";
// 估值优先级纯函数 + 模式(Phase 3)。
export { type ValuationMode, valuate } from "./valuate";
export { CGK_VENDOR, cgkRef, vendorIdOf, vendorPartsOf } from "./vendor";

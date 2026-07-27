// @folio/oracle-basic —— 代币参考层的契约与数据:类型 + 契约接口(TokenSource / TokenStore)+ errors + ref
// + 常量。无逻辑函数——符号消歧策略 / 解析 / 预热服务在 @folio/oracle(entry)。
// source 实现(@folio/oracle-source-coingecko)依赖本包的契约面。

export {
  CGK_RECHECK_TTL_MS,
  DEFAULT_TOP_N,
  dayBucketOf,
  INFO_TTL_MS,
  MS_PER_DAY,
  OVERRIDES,
  PRICE_TTL_MS,
  RESOLUTION_DOMINANCE,
  RESOLUTION_TOP_RANK,
  TOKEN_REF_TTL_MS,
  TOP_TOKENS_LIMIT,
  WARM_TTL_MS,
} from "./constants";
export type { TokenErrorCode } from "./errors";
export { TokenError } from "./errors";
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

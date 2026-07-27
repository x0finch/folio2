// @folio/oracle2-basic —— 代币参考层的契约与数据:类型 + 端口(`*Store` 本地 / `*Upstream` 出网)
// + 常量。**无逻辑函数** —— 符号消歧策略 / 缓存编排 / 预热服务在 @folio/oracle2(entry)。
// 上游实现(@folio/oracle2-upstream-coingecko)依赖本包的契约面。
//
// **这一层不许出现任何数据源的名字**,dependencies 只有 `@folio/oracle-ref`(文法);
// 上游实例由 app 在初始化时注入(ADR 0023)。

export {
  DEFAULT_TOP_N,
  dayBucketOf,
  FX_TTL_MS,
  INFO_TTL_MS,
  MS_PER_DAY,
  normalizeSymbol,
  PLATFORM_NEG_TTL_MS,
  PLATFORM_TTL_MS,
  PRICE_TTL_MS,
  RESOLUTION_DOMINANCE,
  RESOLUTION_TOP_RANK,
  TOP_TOKENS_LIMIT,
  WARM_TTL_MS,
} from "./constants";
// 展示币种 + 汇率(存储恒 USD,换算只在展示层;ADR 0006)。
export { type Currency, DEFAULT_CURRENCY, SUPPORTED_CURRENCIES } from "./fx";
// 平台(链 ∪ 场馆)的名与图。
export type { PlatformMeta } from "./platform";
export type {
  CacheEntry,
  CacheStore,
  GlobalTokenRefIndexStore,
  TokenPriceStore,
  TokenStore,
} from "./stores";
export type {
  ProviderTokenSeed,
  TokenCandidate,
  TokenInfo,
  TokenInfoPatch,
  TokenInfoWrite,
  TokenPrice,
  TokenPricePoint,
  TokenPriceWrite,
  TokenRecord,
  TokenRecordPrice,
  TokenRef,
  TokenRefHit,
  TokenRefIndexRow,
} from "./types";
export type {
  FxUpstream,
  PlatformUpstream,
  PriceUpstream,
  RefIndexFetch,
  TokenMetaUpstream,
  TokenRefIndexUpstream,
  TokenUpstream,
  UpstreamToken,
} from "./upstream";

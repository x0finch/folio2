// @folio/tokens —— 全局共享的代币参考层:身份解析 + 市场价 + 元信息(name/symbol/logo)。
// 策略:top-N 预热 + 按需 per-contract 懒解析。契约 + 纯策略 + 接口驱动的解析/刷新服务;
// 上游实现(@folio/tokens-coingecko)、KV 缓存(@folio/tokens-store-kv)、接入富化(P7.4)对着这组契约编写。

export {
  ABSENT_TTL_MS,
  CONTRACT_TTL_MS,
  DEFAULT_TOP_N,
  OVERRIDES,
  PRICE_TTL_MS,
  RESOLUTION_DOMINANCE,
  RESOLUTION_TOP_RANK,
  WARM_TTL_MS,
} from "./constants";
export type { TokenErrorCode } from "./errors";
export { TokenError } from "./errors";
export { parseRefKey, refKey } from "./ref";
export {
  type ConfidenceOpts,
  chooseResolution,
  normalizeSymbol,
  pickByConfidence,
} from "./resolve";
export {
  type RefreshDeps,
  type RefreshOpts,
  type ResolveDeps,
  refreshWarm,
  resolveAsset,
} from "./service";
export type { TokenSource } from "./source";
export type { TokenStore } from "./store";
export type {
  AssetRef,
  CoinId,
  Confidence,
  Resolution,
  ResolutionVia,
  TokenCandidate,
  TokenInfo,
  TokenPrice,
  TokenRef,
} from "./types";

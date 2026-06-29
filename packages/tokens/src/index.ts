// @folio/tokens —— 全局共享的代币参考层:身份解析 + 市场价 + 元信息(name/symbol/logo)。
// P7.1 = 契约 + 纯策略;网络实现(P7.2)、D1 缓存(P7.3)、接入富化(P7.4)对着这组稳定契约编写。

export {
  ABSENT_TTL_MS,
  INDEX_TTL_MS,
  OVERRIDES,
  PRICE_TTL_MS,
  RESOLUTION_DOMINANCE,
  RESOLUTION_TOP_RANK,
  TOKENINFO_TTL_MS,
} from "./constants";
export type { TokenErrorCode } from "./errors";
export { TokenError } from "./errors";

export { parseRefKey, refKey } from "./ref";
export {
  type ConfidenceOpts,
  chooseResolution,
  lookupByContract,
  lookupBySymbol,
  normalizeSymbol,
  pickByConfidence,
  resolve,
} from "./resolve";
export type { TokenSource } from "./source";
export type { TokenStore } from "./store";
export type {
  AssetRef,
  CoinId,
  Confidence,
  Fiat,
  Resolution,
  ResolutionVia,
  TokenCandidate,
  TokenIndex,
  TokenInfo,
  TokenPrice,
  TokenRef,
} from "./types";

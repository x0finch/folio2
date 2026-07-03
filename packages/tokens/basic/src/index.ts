// @folio/tokens-basic —— 代币参考层的契约与数据:类型 + 契约接口(TokenProvider / TokenStore)+ errors + ref
// + 常量。无逻辑函数——符号消歧策略 / 解析 / 预热服务在 @folio/tokens(entry)。
// provider 实现(@folio/tokens-provider-coingecko)依赖本包的契约面。

export {
  ABSENT_TTL_MS,
  CONTRACT_TTL_MS,
  DEFAULT_TOP_N,
  INFO_TTL_MS,
  OVERRIDES,
  PRICE_TTL_MS,
  RESOLUTION_DOMINANCE,
  RESOLUTION_TOP_RANK,
  TOP_TOKENS_LIMIT,
  WARM_TTL_MS,
} from "./constants";
export type { TokenErrorCode } from "./errors";
export { TokenError } from "./errors";
export type { TokenProvider } from "./provider";
export { parseRefKey, refKey } from "./ref";
export type { TokenStore } from "./store";
export type {
  AssetRef,
  Confidence,
  Resolution,
  ResolutionVia,
  TokenCandidate,
  TokenIdentifier,
  TokenInfo,
  TokenPrice,
  TokenRef,
} from "./types";

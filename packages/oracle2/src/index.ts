// @folio/oracle2 —— 参考层的新实现(#176 / ADR 0021 / ADR 0022 / ADR 0023)。
//
// 与今天的 `@folio/oracle` 的根本差别:
//   · 代币表**每个用户一份**,`tokens.id` 是系统内部唯一身份,`tokenRef` 退回两个边界
//   · 认币从**读时**挪到**写时**,结果冻进快照
//   · **这个包不知道上游是谁** —— store 与 upstream 都是初始化时注入的惰性工厂,
//     `dependencies` 里只有 `@folio/oracle-ref`(文法),没有任何 client / upstream 包
//
// 三层:`src/contract/`(类型 + 端口,零逻辑)/ `src/services/`(编排)/ adapter 另成包。
// 包名 `oracle2` 是临时的:写到满意后改名接管 `oracle`,老包整个删除(#202)。

export type * from "./contract";
export {
  cacheKeys,
  candidatesBySymbol,
  type PlatformMeta,
  readFx,
  readPlatform,
  topByRank,
  type WarmBlob,
  type WarmInfo,
  warmRows,
  writeFx,
  writePlatform,
} from "./services/cache";
export { pickByConfidence } from "./services/confidence";
export {
  DEFAULT_TOP_N,
  dayBucketOf,
  FX_TTL_MS,
  INFO_TTL_MS,
  MS_PER_DAY,
  normalizeSymbol,
  PLATFORM_TTL_MS,
  PRICE_TTL_MS,
  RESOLUTION_DOMINANCE,
  RESOLUTION_TOP_RANK,
  TOP_TOKENS_LIMIT,
  WARM_TTL_MS,
} from "./services/constants";
export {
  type CandidateSource,
  createMint,
  type Mint,
  type MintDeps,
  type MintInput,
} from "./services/mint";
export {
  createOracleFor,
  createOracleWarm,
  type Oracle,
  type OracleConfig,
  type OracleFor,
  type OracleWarm,
  type OracleWarmConfig,
} from "./services/oracle";
export { swr } from "./services/refresh";
export { createTokens, type Tokens, type TokensDeps } from "./services/tokens";

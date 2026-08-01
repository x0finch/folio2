// @folio/oracle —— 参考层的服务层与对外门面(#176 / ADR 0021 / 0022 / 0023)。
//
// 设计要点(#202 起是唯一一套,旧参考层已删):
//   · 代币表**每个用户一份**,`tokens.id` 是系统内部唯一身份,`tokenRef` 退回两个边界
//   · 认币从**读时**挪到**写时**,结果冻进快照
//   · **这个包不知道上游是谁** —— store 与 upstream 都是初始化时注入的惰性工厂,
//     dependencies 里只有契约包与文法包,没有任何 client / upstream 包
//
// 三包一族:`@folio/oracle-basic`(契约)/ `@folio/oracle`(本包,服务)/
// `@folio/oracle-upstream-coingecko`(上游 adapter)。

// 契约与数据经门面透出,调用方一个 import 面(同现有 @folio/oracle 的做法)。
export * from "@folio/oracle-basic";
export {
  cacheKeys,
  candidatesBySymbol,
  type PlatformEntry,
  readFx,
  readFxFreshness,
  readPlatforms,
  refreshCatalogue,
  topByRank,
  type WarmBlob,
  type WarmInfo,
  warmCatalogue,
  warmMarkets,
  writeFx,
  writePlatforms,
} from "./cache";
export { type CandidateSourceDeps, createCandidateSource } from "./candidates";
export { pickByConfidence } from "./confidence";
export { createDefiLogos, type DefiLogos, type DefiLogosDeps } from "./defi-logos";
export { createFxRates, deriveFiatDaily, type FxRates, type FxRatesDeps } from "./fx";
export {
  type CandidateSource,
  createMint,
  type Mint,
  type MintDeps,
  type MintInput,
} from "./mint";
export {
  createOracleFor,
  createOracleWarm,
  type Oracle,
  type OracleConfig,
  type OracleFor,
  type OracleWarm,
  type OracleWarmConfig,
} from "./oracle";
export { createPlatforms, type Platforms, type PlatformsDeps } from "./platforms";
export { swr } from "./refresh";
export { createTokens, type Tokens, type TokensDeps } from "./tokens";

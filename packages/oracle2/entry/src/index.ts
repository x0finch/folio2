// @folio/oracle2 —— 参考层的服务层与对外门面(#176 / ADR 0021 / 0022 / 0023)。
//
// 与今天的 `@folio/oracle` 的根本差别:
//   · 代币表**每个用户一份**,`tokens.id` 是系统内部唯一身份,`tokenRef` 退回两个边界
//   · 认币从**读时**挪到**写时**,结果冻进快照
//   · **这个包不知道上游是谁** —— store 与 upstream 都是初始化时注入的惰性工厂,
//     dependencies 里只有契约包与文法包,没有任何 client / upstream 包
//
// 三包同现有 oracle 家族的形状:`oracle2-basic`(契约)/ `oracle2`(本包,服务)/
// `oracle2-upstream-coingecko`(上游 adapter)。包名带 `2` 是临时的,#202 改名接管。

// 契约与数据经门面透出,调用方一个 import 面(同现有 @folio/oracle 的做法)。
export * from "@folio/oracle2-basic";
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
} from "./cache";
export { pickByConfidence } from "./confidence";
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
export { swr } from "./refresh";
export { createTokens, type Tokens, type TokensDeps } from "./tokens";

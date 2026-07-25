// @folio/oracle2 —— 参考层的新实现(#176 / ADR 0021)。
//
// 与今天的 `@folio/oracle` 的根本差别:代币表是**每个用户一份**,`tokens.id` 是系统内部唯一的
// 身份,`tokenRef` 退回两个边界(连接器报余额、oracle 问 CoinGecko)。认币从**读时**挪到
// **写时**,结果冻进快照。
//
// 包名 `oracle2` 是临时的:写到满意之后它改名接管 `oracle`,老包整个删除(#204)。
// 在那之前它零消费者、不碰 schema —— 老 oracle 全程照跑,CI 一直绿。

export type { CgkRefs } from "./cgk-refs";
export type { Mint, MintInput } from "./mint";
export {
  createOracleFor,
  type Oracle,
  type OracleConfig,
  type OracleFor,
  type OracleStores,
} from "./oracle";
export type {
  CacheEntry,
  CacheStore,
  CgkRefStore,
  SourcePrice,
  SourceToken,
  TokenSource,
  TokenStore,
} from "./stores";
export type { Tokens } from "./tokens";
export type {
  CgkRefRow,
  PricePoint,
  Token,
  TokenInfoPatch,
  TokenPrice,
  TokenPriceWrite,
  TokenRef,
  TokenSeed,
} from "./types";

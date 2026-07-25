// @folio/oracle —— 对外门面。暴露:契约与数据(re-export @folio/oracle-basic:类型 + 接口 + errors + ref + 常量)
// + 统一组装入口 createOracle(返回 Oracle = {tokens,platforms,fx},三服务皆 CoinGecko 供源,#79)。
// 解析/预热/symbol 归一都是实现细节,经服务实例的方法用,不单独对外导出。
// createTokens/createPlatforms/createFxRates 具名透出,供 app 侧装配(ADR 0012 Phase 2 已收口:
// 旧的 @folio/tokens / @folio/tokens-basic shim 已删,调用方直接用 oracle 词汇)。

export * from "@folio/oracle-basic";
// 平台 / 汇率的 CoinGecko source 经门面透出:调用方「source + service」自行组装。
export {
  createCoinGeckoFxSource,
  createCoinGeckoPlatformSource,
} from "@folio/oracle-source-coingecko";
// 统一 Oracle 门面(#79):一个入口组合三服务。
export { type CreateOracleConfig, createOracle, type Oracle } from "./oracle";
// 平台 / 汇率的组装服务(折入自 @folio/platforms、@folio/fx,#72)。类型经 @folio/oracle-basic 透出。
export { type CreateFxRatesConfig, createFxRates } from "./services/fx";
export { type CreatePlatformsConfig, createPlatforms } from "./services/platforms";
export {
  type CreateTokensConfig,
  createTokens,
  type EnrichedAsset,
  type ProviderAsset,
  type Tokens,
} from "./services/tokens";

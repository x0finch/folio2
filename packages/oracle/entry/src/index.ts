// @folio/oracle —— 对外门面。暴露:契约与数据(re-export @folio/oracle-basic:类型 + 接口 + errors + ref + 常量)
// + 统一组装入口 createOracle(返回 Oracle = {tokens,platforms,fx},按活跃源路由 + 缺能力回退 baseline,#79)。
// 解析/预热/symbol 归一/vendor 路由都是实现细节,经服务实例的方法用,不单独对外导出。
// createTokens/createPlatforms/createFxRates 仍具名透出:shim(@folio/tokens 等)与既有 import 用它们,
// Phase 2(contract)统一改到 oracle 词汇后收口 —— 见 ADR 0012/0013。

export * from "@folio/oracle-basic";
// 平台 / 汇率的 CoinGecko source 经门面透出:shim 仍「source + service」自行组装(与旧公共面一致)。
export {
  createCoinGeckoFxSource,
  createCoinGeckoPlatformSource,
} from "@folio/oracle-source-coingecko";
// 统一 Oracle 门面(#79):一个入口组合三服务 + capability 路由。
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
export { BASELINE_VENDOR, VENDORS, type VendorImpl } from "./vendors";

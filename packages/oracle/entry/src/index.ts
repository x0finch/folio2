// @folio/oracle —— 对外门面。只暴露:契约与数据(re-export @folio/oracle-basic:类型 + 接口 + errors + ref + 常量)
// 以及唯一组装入口 createOracle(返回一个 Tokens 实例)。解析/预热/symbol 归一都是实现细节,
// 经该实例的方法用(或在 store 调用前完成),不单独对外导出。
// createTokens 是 createOracle 的旧名别名,保留至 Phase 2(contract)统一改到 oracle 词汇 —— 见 ADR 0012。

export * from "@folio/oracle-basic";
// 平台 / 汇率的 CoinGecko source 经门面透出:app 仍「source + service」自行组装(与旧 @folio/platforms、
// @folio/fx 的公共面一致)。代币 provider 由 createOracle 内部按 config 构造、不外露,故此处不透出。
export {
  createCoinGeckoFxSource,
  createCoinGeckoPlatformSource,
} from "@folio/oracle-provider-coingecko";
// 平台 / 汇率的组装服务(折入自 @folio/platforms、@folio/fx,#72)。类型经 @folio/oracle-basic 透出。
export { type CreateFxRatesConfig, createFxRates } from "./fx-service";
export { type CreatePlatformsConfig, createPlatforms } from "./platforms-service";
export {
  type CreateTokensConfig,
  // createOracle = 门面组装入口(#71 AC 命名);createTokens 保留别名,shim + 现有 import 仍用它。
  createTokens as createOracle,
  createTokens,
  type EnrichedAsset,
  type ProviderAsset,
  type Tokens,
} from "./tokens";

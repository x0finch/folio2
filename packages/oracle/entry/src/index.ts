// @folio/oracle —— 对外门面。暴露:契约与数据(re-export @folio/oracle-basic:类型 + 接口 + errors + ref + 常量)
// + 统一组装入口 createOracle(#79)。解析/预热/symbol 归一都是实现细节,经服务实例的方法用。
//
// **只剩代币了**:平台与汇率已搬进 @folio/oracle2(#202b),代币那面随选币与预热两片一起退场。

export * from "@folio/oracle-basic";
// 统一 Oracle 门面(#79)。平台与汇率都已搬进 @folio/oracle2(#202b)—— 只剩代币。
export { type CreateOracleConfig, createOracle, type Oracle } from "./oracle";
export {
  type CreateTokensConfig,
  createTokens,
  type EnrichedAsset,
  type ProviderAsset,
  type Tokens,
} from "./services/tokens";

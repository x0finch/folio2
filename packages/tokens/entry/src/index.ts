// @folio/tokens —— 对外门面。只暴露:契约与数据(re-export @folio/tokens-basic:类型 + 接口 + errors + ref + 常量)
// 以及唯一组装入口 createTokens(返回一个 Tokens 实例)。解析/预热/symbol 归一都是实现细节,
// 经 Tokens 实例的方法用(或在 store 调用前完成),不单独对外导出。

export * from "@folio/tokens-basic";
export {
  type CreateTokensConfig,
  createTokens,
  type EnrichedAsset,
  type Tokens,
} from "./tokens";

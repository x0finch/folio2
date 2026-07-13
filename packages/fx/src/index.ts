// Shim(oracle 合包 Phase 1,expand):`@folio/fx` 契约/源/服务已折入 `@folio/oracle`,
// 本包降为 re-export 转发,现有 import 一行不改。Phase 2(contract)删本 shim、把 import 改到 @folio/oracle。
// 分层(CODING.md #21):客户端 value-import 的契约/常量(Currency/DEFAULT_CURRENCY/SUPPORTED_CURRENCIES)
// 只经叶子层 @folio/oracle-basic 透出,绝不经 entry 门面(否则整张 provider 依赖图进 client bundle);
// server-only 的组装工厂/源从 entry/provider 具名再导(client 侧 tree-shake 掉)。

export { createFxRates } from "@folio/oracle";
export * from "@folio/oracle-basic";
export { createCoinGeckoFxSource } from "@folio/oracle-source-coingecko";

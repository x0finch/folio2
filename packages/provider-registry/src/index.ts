// @folio/provider-registry —— provider 运行时注册与配置(ADR 0009)。
// 拥有:全仓唯一的 provider 包组装点(ALL_ENTRIES)+ manifest 驱动的候选/生效解析(纯函数)。
// 本切片(#24)按 manifest 默认解析;#25 起叠加全局配置覆盖(启停/选中/settings 分层)。
export { ALL_ENTRIES } from "./entries";
export { buildCandidates, type ProviderCandidates, resolveActive } from "./registry";

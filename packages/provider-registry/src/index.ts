// @folio/provider-registry —— provider 运行时注册与配置(ADR 0009)。
// 拥有:全仓唯一的 provider 包组装点(ALL_ENTRIES)+ manifest 驱动的候选/生效解析 + settings 分层(纯函数)。
// 覆盖表存取在 @folio/db(createProviderConfigStore);secret 解密在 app(creds.ts)——本包不碰 D1/SECRETS_KEY。
export {
  ACCOUNT_TYPE_SPECS,
  type AccountTypeSpec,
  accountInputs,
} from "./account-types";
export { ALL_ENTRIES } from "./entries";
export {
  buildCandidates,
  type EnabledOverrides,
  type ProviderCandidates,
  resolveActive,
  resolveSettings,
} from "./registry";

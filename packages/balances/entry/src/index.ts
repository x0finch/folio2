// @folio/balances —— 余额侧对外门面。只暴露领域意图(createBalances → Balances 实例)+ 类型 + 少量
// 纯契约值。registry 机制、provider 组装、creds 封装/解密/投影/校验、全局 key 收窄、provider.inputs 访问
// 全部内部化(见 ./balances、./registry),调用方(app / sync)只表达意图,不碰任何原语。
// 分层照 tokens:provider 实现依赖 @folio/balances-basic(纯契约);app / sync / db 一律从本门面引。

// 类型全量转发(类型不能用于编排,安全);值只白名单放行,原语(sealCreds/openCreds/safeView/isComplete/
// validateCredentials/publicKeys/…/getProvider/buildRegistry)不出门面。
export type * from "@folio/balances-basic";
export {
  maskCredential, // 客户端凭据提示打码(纯展示)
  ProviderError, // sync 据 instanceof 判定 retryable
  SEMI_PREFIX, // 导入重建 creds 的 semi 占位前缀
} from "@folio/balances-basic";
export type { FetchOutcome, InputSpec } from "./balances";
export { type Balances, type CreateBalancesConfig, createBalances } from "./balances";

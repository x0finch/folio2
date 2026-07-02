// @folio/balances —— 余额侧对外门面。只暴露【必须依赖 provider 实现】的领域能力(createBalances → Balances:
// credentialSpecs / validateCredentials / fetchBalances)+ 类型 + 少量通用值(错误契约、crypto、打码)。
// registry 组装/查找全部内部化。凭据的加密/脱敏/补录塑形归业务层(app lib/creds.ts),靠 credentialSpecs 驱动。

// 类型全量转发(类型不能用于编排,安全)。
export type * from "@folio/balances-basic";
// 通用值:错误契约(sync 据 instanceof 重试)、crypto(app 的 creds 塑形用)、打码(前端 + safeView)。
export {
  decrypt,
  encrypt,
  generateSecret,
  maskCredential,
  ProviderError,
} from "@folio/balances-basic";
export type { AccountShell, Balances, CreateBalancesConfig, InputSpec } from "./balances";
export { createBalances } from "./balances";

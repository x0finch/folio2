import type { AccountType, Balance } from "./types";

export interface ProviderCredentials {
  apiKey?: string;
  secret?: string;
  passphrase?: string;
  // 单地址,或 BTC 的 xpub/ypub/zpub(只读,不存私钥)。
  identifier?: string;
}

// 由 ProviderCredentials 自动推导每个字段的 "has<Field>" 可选布尔。
// 加凭据字段时,Account 上的 has* 标志随之自动出现,无需手写、不会漏。
// 当前推导出 { hasApiKey?, hasSecret?, hasPassphrase?, hasIdentifier? }。
export type CredentialFlags = {
  [K in keyof ProviderCredentials as `has${Capitalize<string & K>}`]?: boolean;
};

export interface BalanceProvider {
  // 该实现服务于哪个 AccountType —— 这是 "provider ↔ type" 映射的唯一事实源。
  // registry 由各 provider 的此字段自动组装(见 registry.ts),不另外手写映射表。
  // 一个数据源若服务多个 type(如 coinstats),用工厂导出多个 BalanceProvider 对象、
  // 各绑定一个 type(共享内部实现),由 sync 摊平后传入 buildRegistry。
  readonly accountType: AccountType;
  /** 拉取该账户当前全部余额。失败抛 ProviderError。 */
  fetchBalances(
    creds: ProviderCredentials,
    globalKeys: Record<string, string>, // ZERION_API_KEY 等服务端全局 key
  ): Promise<Balance[]>;
  /** 校验凭据是否可用,加账户时调用。 */
  validate(creds: ProviderCredentials, globalKeys: Record<string, string>): Promise<boolean>;
}

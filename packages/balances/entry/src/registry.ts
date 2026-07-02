import type { AccountType, BalanceProvider } from "@folio/balances-basic";

// registry 机制(组装 + 查找)。type → provider 的查找,取代 Account.provider 字段:编排层不读
// account.provider,而是拿 account.type 来查。关键:registry 不手写映射表,而由各 provider 的 accountType
// 字段【自动组装】——「provider 服务哪个 type」只在 provider 自身声明一次(单一事实源),新增 provider 只需
// 加进列表,不可能写错或漏登记 key。用 Partial:尚未实现的 type 允许缺席,getProvider 运行时兜底报错。
export type ProviderRegistry = Partial<Record<AccountType, BalanceProvider>>;

/** 从一组 provider 自动组装 registry(同一 type 重复实现则抛错,防止静默覆盖)。 */
export function buildRegistry(providers: BalanceProvider[]): ProviderRegistry {
  const registry: ProviderRegistry = {};
  for (const provider of providers) {
    if (registry[provider.accountType]) {
      throw new Error(`Duplicate provider for account type: ${provider.accountType}`);
    }
    registry[provider.accountType] = provider;
  }
  return registry;
}

export function getProvider(registry: ProviderRegistry, type: AccountType): BalanceProvider {
  const provider = registry[type];
  if (!provider) {
    throw new Error(`No provider registered for account type: ${type}`);
  }
  return provider;
}

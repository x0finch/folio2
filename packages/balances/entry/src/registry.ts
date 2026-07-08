import type { AccountType, BalanceProvider } from "@folio/balances-basic";
import { ALL_ENTRIES, buildCandidates, resolveActive } from "@folio/provider-registry";

// registry 机制 —— @folio/balances 内部件,仅 createBalances(及白盒测试)使用,不对外导出。
// type → 生效 provider 的映射。默认由 manifest 解析(ADR 0009);运行时按覆盖表/settings 解析
// 由 app 注入(CreateBalancesConfig.resolveProvider)。provider 不再带 accountType —— 键由此表/manifest 提供。
export type ProviderRegistry = Partial<Record<AccountType, BalanceProvider>>;

export function getProvider(registry: ProviderRegistry, type: AccountType): BalanceProvider {
  const provider = registry[type];
  if (!provider) {
    throw new Error(`No provider registered for account type: ${type}`);
  }
  return provider;
}

// 静态默认 registry:manifest 默认解析(resolveActive)+ 无 settings 实例化(带全局 key 的 provider
// 在此形态取数会抛"key 未配置" —— 运行时应经 app 注入的 resolveProvider 拿带 settings 的实例)。
function defaultRegistry(): ProviderRegistry {
  const active = resolveActive(buildCandidates(ALL_ENTRIES));
  const registry: ProviderRegistry = {};
  for (const [type, entry] of Object.entries(active)) {
    if (entry) registry[type as AccountType] = entry.create();
  }
  return registry;
}

export const registry: ProviderRegistry = defaultRegistry();

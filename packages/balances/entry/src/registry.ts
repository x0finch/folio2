import type { AccountType, BalanceProvider } from "@folio/balances-basic";
import { providers as binanceProviders } from "@folio/balances-provider-binance";
import { providers as coinstatsProviders } from "@folio/balances-provider-coinstats";
import { providers as customProviders } from "@folio/balances-provider-custom";
import { providers as hyperliquidProviders } from "@folio/balances-provider-hyperliquid";
import { providers as okxProviders } from "@folio/balances-provider-okx";
import { providers as zerionProviders } from "@folio/balances-provider-zerion";

// registry 机制 + 应用级组装 —— 均为 @folio/balances 内部件,仅 createBalances(及白盒测试)使用,不对外导出。
// type → provider 查找:不手写映射表,由各 provider 的 accountType 字段【自动组装】(单一事实源);
// 新增 provider 只需加进下面的列表,不可能写错或漏登记 key。用 Partial:未实现的 type 允许缺席,运行时兜底报错。
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

// 应用级 provider 装配(方案 A 摊平):收集各 provider 包导出的 providers。新增 provider 包 → 在此 import 并摊平。
// coinstats 是多类型包(一包多 provider),摊平各自登记。
const providers = [
  ...customProviders,
  ...zerionProviders,
  ...coinstatsProviders,
  ...binanceProviders,
  ...okxProviders,
  ...hyperliquidProviders,
];

export const registry = buildRegistry(providers);

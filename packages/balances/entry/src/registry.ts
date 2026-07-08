import type { AccountType, BalanceProvider } from "@folio/balances-basic";
import { ALL_ENTRIES, buildCandidates, resolveActive } from "@folio/provider-registry";

// registry 机制 —— @folio/balances 内部件,仅 createBalances(及白盒测试)使用,不对外导出。
// 应用级组装(provider 包 import 清单 + manifest 候选/生效解析)已迁至 @folio/provider-registry
// (ADR 0009):本包不再持有 type→provider 硬编码;默认 registry 由 manifest 解析而来。
// buildRegistry 保留给注入路径(createBalances({providers}),测试用)。
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

// 默认 registry:manifest 驱动(defaultEnabled 的候选生效)。#25 起改为叠加全局配置覆盖解析。
export const registry: ProviderRegistry = resolveActive(buildCandidates(ALL_ENTRIES));

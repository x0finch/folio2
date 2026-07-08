import type { AccountType, BalanceProvider, ProviderEntry } from "@folio/balances-basic";

// registry 机制(纯函数,ADR 0009):manifest 驱动的候选组装与生效解析。
// 本切片(#24)无配置层 —— 生效 = manifest.defaultEnabled;#25 起叠加覆盖表(启停/选中/settings)。

// 候选集合:同一 accountType 可有多个后端(方案 A:一个后端一个独立 entry)。
export type ProviderCandidates = Map<AccountType, ProviderEntry[]>;

/** 收集 entries → 按 accountType 分桶。manifest.id 全局唯一(重复 = 组装 bug,抛错)。 */
export function buildCandidates(entries: readonly ProviderEntry[]): ProviderCandidates {
  const seen = new Set<string>();
  const candidates: ProviderCandidates = new Map();
  for (const entry of entries) {
    const { id, accountType } = entry.manifest;
    if (seen.has(id)) throw new Error(`Duplicate provider manifest id: ${id}`);
    seen.add(id);
    if (entry.manifest.accountType !== entry.provider.accountType) {
      throw new Error(`Manifest/provider accountType mismatch for: ${id}`);
    }
    const list = candidates.get(accountType) ?? [];
    list.push(entry);
    candidates.set(accountType, list);
  }
  return candidates;
}

/**
 * 解析各 type 的生效 provider(本切片按 manifest 默认):
 * 每 type 取 defaultEnabled 的候选;恰一个 → 生效;零个 → 该 type 缺席(未启用);
 * 多个默认启用 = manifest 声明冲突(同 type 至多一个默认),抛错暴露组装 bug。
 */
export function resolveActive(
  candidates: ProviderCandidates,
): Partial<Record<AccountType, BalanceProvider>> {
  const active: Partial<Record<AccountType, BalanceProvider>> = {};
  for (const [type, list] of candidates) {
    const enabled = list.filter((e) => e.manifest.defaultEnabled);
    if (enabled.length > 1) {
      throw new Error(
        `Multiple default-enabled providers for account type ${type}: ${enabled
          .map((e) => e.manifest.id)
          .join(", ")}`,
      );
    }
    if (enabled.length === 1) active[type] = enabled[0].provider;
  }
  return active;
}

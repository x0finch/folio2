import type { AccountType, ProviderEntry, ProviderManifest } from "@folio/balances-basic";

// registry 机制(纯函数,ADR 0009):manifest 驱动的候选组装 + 覆盖表感知的生效解析 + settings 分层。
// 覆盖表(D1,@folio/db createProviderConfigStore)只存偏离默认的记录;空覆盖 = manifest 默认。

// 候选集合:同一 accountType 可有多个后端(方案 A:一个后端一个独立 entry)。
export type ProviderCandidates = Map<AccountType, ProviderEntry[]>;

// 启停覆盖:manifest.id → enabled(true=选中启用 / false=显式停用 / null·缺席=不覆盖)。
export type EnabledOverrides = ReadonlyMap<string, boolean | null>;

const NO_OVERRIDES: EnabledOverrides = new Map();

/** 收集 entries → 按 accountType 分桶。manifest.id 全局唯一(重复 = 组装 bug,抛错)。 */
export function buildCandidates(entries: readonly ProviderEntry[]): ProviderCandidates {
  const seen = new Set<string>();
  const candidates: ProviderCandidates = new Map();
  for (const entry of entries) {
    const { id, accountType } = entry.manifest;
    if (seen.has(id)) throw new Error(`Duplicate provider manifest id: ${id}`);
    seen.add(id);
    const list = candidates.get(accountType) ?? [];
    list.push(entry);
    candidates.set(accountType, list);
  }
  return candidates;
}

/**
 * 解析各 type 的生效 entry(启用状态 = 覆盖 ?? manifest 默认):
 * 1. 有 enabled=true 覆盖的候选 → 即选中(用户显式选择;store 保证每 type 至多一条 true,>1 抛错);
 * 2. 否则 defaultEnabled 且未被 enabled=false 覆盖的候选 → 生效(恰一个;>1 = manifest 声明冲突,抛错);
 * 3. 都没有 → 该 type 缺席(未启用)。
 * 指向已从代码移除的 provider 的陈旧覆盖行(id 不在候选里)被静默忽略 → 优雅降级回 manifest 默认
 * (manifest 是事实源,DB 只是覆盖;不因脏行拒绝启动)。
 */
export function resolveActive(
  candidates: ProviderCandidates,
  overrides: EnabledOverrides = NO_OVERRIDES,
): Partial<Record<AccountType, ProviderEntry>> {
  const active: Partial<Record<AccountType, ProviderEntry>> = {};
  for (const [type, list] of candidates) {
    const selected = list.filter((e) => overrides.get(e.manifest.id) === true);
    if (selected.length > 1) {
      throw new Error(
        `Multiple enabled providers for account type ${type}: ${ids(selected)} (config invariant broken)`,
      );
    }
    if (selected.length === 1) {
      active[type] = selected[0];
      continue;
    }
    const defaults = list.filter(
      (e) => e.manifest.defaultEnabled && overrides.get(e.manifest.id) !== false,
    );
    if (defaults.length > 1) {
      throw new Error(
        `Multiple default-enabled providers for account type ${type}: ${ids(defaults)}`,
      );
    }
    if (defaults.length === 1) active[type] = defaults[0];
  }
  return active;
}

const ids = (list: ProviderEntry[]): string => list.map((e) => e.manifest.id).join(", ");

/**
 * settings 分层解析(每字段):用户自定义(D1,已解密)→ envDefaults 声明的部署时默认 → 缺失。
 * env 以纯 record 传入(本包不碰 cloudflare env);只解析 configSchema 声明的字段。
 */
export function resolveSettings(
  manifest: ProviderManifest,
  custom: Record<string, string> | undefined,
  env: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const field of manifest.configSchema) {
    const envName = manifest.envDefaults?.[field.key];
    const value = custom?.[field.key] ?? (envName ? env[envName] : undefined);
    if (value) out[field.key] = value;
  }
  return out;
}

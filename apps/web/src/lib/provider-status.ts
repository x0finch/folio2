import type { AccountType, InputSpec, ProviderEntry } from "@folio/balances";
import type { ProviderConfigRow } from "@folio/db";

// 账户类型管理页的视图组装(纯函数,可脱离 server fn 单测)。
// 只产【非密投影】:自定义 settings 仅回"存过哪些字段"(hasCustomSettings),值(即使密文)绝不出服务端。

export interface ProviderCandidateView {
  id: string;
  dataSource: string;
  defaultEnabled: boolean;
  configFields: InputSpec[]; // 全局设置字段(渲染表单用;secret → password 框)
  hasEnvDefault: boolean; // envDefaults 槽在部署环境里有值 → 可"用内置默认"
  hasCustomSettings: boolean; // D1 存了自定义(不回值)
  enabledOverride: boolean | null; // 覆盖行的启停(null/无行 = 不覆盖)
}

export interface AccountTypeStatusView {
  accountType: AccountType;
  activeId: string | null; // 生效 provider(resolveActive 语义)
  configured: boolean; // 生效且每个设置字段可解析(自定义 ?? env 默认)→ 真可用
  accountCount: number; // 该类型下未归档账户数(关闭确认提示用)
  candidates: ProviderCandidateView[];
}

// resolveActive 的轻量重述(entry 级、带覆盖),避免在视图层拖入 provider 实例化。
function activeIdOf(
  list: ProviderEntry[],
  overrides: ReadonlyMap<string, boolean | null>,
): string | null {
  const selected = list.filter((e) => overrides.get(e.manifest.id) === true);
  if (selected.length === 1) return selected[0].manifest.id;
  const defaults = list.filter(
    (e) => e.manifest.defaultEnabled && overrides.get(e.manifest.id) !== false,
  );
  return defaults.length === 1 ? defaults[0].manifest.id : null;
}

export function buildProviderStatusView(
  candidates: ReadonlyMap<AccountType, ProviderEntry[]>,
  rows: readonly ProviderConfigRow[],
  envPresence: (envName: string) => boolean,
  accountCounts: ReadonlyMap<AccountType, number> = new Map(),
): AccountTypeStatusView[] {
  const rowById = new Map(rows.map((r) => [r.providerId, r]));
  const overrides = new Map(rows.map((r) => [r.providerId, r.enabled]));
  const out: AccountTypeStatusView[] = [];
  for (const [accountType, list] of candidates) {
    const views: ProviderCandidateView[] = list.map((e) => {
      const row = rowById.get(e.manifest.id);
      const stored = row?.settings ? Object.keys(JSON.parse(row.settings)) : [];
      return {
        id: e.manifest.id,
        dataSource: e.manifest.dataSource,
        defaultEnabled: e.manifest.defaultEnabled,
        configFields: e.manifest.configSchema.map((i) => ({
          key: i.key,
          type: i.type,
          label: i.label,
          desc: i.desc,
        })),
        hasEnvDefault:
          e.manifest.configSchema.length > 0 &&
          e.manifest.configSchema.every((f) => {
            const envName = e.manifest.envDefaults?.[f.key];
            return envName ? envPresence(envName) : false;
          }),
        hasCustomSettings: stored.length > 0,
        enabledOverride: row?.enabled ?? null,
      };
    });
    const activeId = activeIdOf(list, overrides);
    const active = activeId ? list.find((e) => e.manifest.id === activeId) : undefined;
    const activeView = views.find((v) => v.id === activeId);
    // 可用 = 生效且每个设置字段可解析(存过自定义 或 env 槽有值);无设置字段 = 恒可解析。
    const configured =
      !!active &&
      active.manifest.configSchema.every((f) => {
        const row = rowById.get(active.manifest.id);
        const customKeys: string[] = row?.settings ? Object.keys(JSON.parse(row.settings)) : [];
        if (customKeys.includes(f.key)) return true;
        const envName = active.manifest.envDefaults?.[f.key];
        return envName ? envPresence(envName) : false;
      }) &&
      !!activeView;
    out.push({
      accountType,
      activeId,
      configured,
      accountCount: accountCounts.get(accountType) ?? 0,
      candidates: views,
    });
  }
  return out;
}

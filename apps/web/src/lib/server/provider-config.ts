import { env } from "cloudflare:workers";
import type { AccountType, BalanceProvider, InputSpec, ProviderEntry } from "@folio/balances";
import { createProviderConfigStore, type ProviderConfigRow } from "@folio/db";
import {
  ALL_ENTRIES,
  buildCandidates,
  resolveActive,
  resolveSettings,
} from "@folio/provider-registry";
import { openCreds } from "../creds";

// provider 运行时解析(ADR 0009)—— server-only 组装点:覆盖表(D1)+ manifest 候选 → 生效 entry
// → settings 分层(自定义 sealed → SECRETS_KEY 解密;否则 envDefaults 槽)→ 工厂实例化。
// 解密只在此处、即用即弃(P6.7 红线);@folio/provider-registry 与 @folio/db 均不碰 SECRETS_KEY。

// 候选集合静态(entries 编译期确定,重复 id 在模块加载时即抛)。
const candidates = buildCandidates(ALL_ENTRIES);

// configSchema(ProviderInput)→ InputSpec 投影(seal/open 只需 key/type/label)。
function configSpecs(entry: ProviderEntry): InputSpec[] {
  return entry.manifest.configSchema.map((i) => ({
    key: i.key,
    type: i.type,
    label: i.label,
    desc: i.desc,
  }));
}

async function readOverrides(): Promise<ProviderConfigRow[]> {
  return createProviderConfigStore(env).getAll();
}

// 生效 entry 表(类型管理页 ③ / 生命周期 ④ 复用)。
export async function resolveActiveEntries(): Promise<Partial<Record<AccountType, ProviderEntry>>> {
  const rows = await readOverrides();
  return resolveActive(candidates, new Map(rows.map((r) => [r.providerId, r.enabled])));
}

// 生效 provider 实例(注入 createBalances.resolveProvider)。undefined = 该 type 未启用。
export async function resolveProvider(type: AccountType): Promise<BalanceProvider | undefined> {
  const rows = await readOverrides();
  const entry = resolveActive(candidates, new Map(rows.map((r) => [r.providerId, r.enabled])))[
    type
  ];
  if (!entry) return undefined;
  let settings: Record<string, string> | undefined;
  if (entry.manifest.configSchema.length > 0) {
    const row = rows.find((r) => r.providerId === entry.manifest.id);
    const custom = row?.settings
      ? await openCreds(
          configSpecs(entry),
          JSON.parse(row.settings) as Record<string, string>,
          env.SECRETS_KEY,
        )
      : undefined;
    // envDefaults 槽按名索引 env(部署时注入的默认 key);Cloudflare.Env 无索引签名 → record 视图。
    settings = resolveSettings(
      entry.manifest,
      custom,
      env as unknown as Record<string, string | undefined>,
    );
  }
  return entry.create(settings);
}

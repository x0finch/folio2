import { env } from "cloudflare:workers";
import { validateCredentials } from "@folio/balances";
import { createProviderConfigStore } from "@folio/db";
import { ALL_ENTRIES, buildCandidates } from "@folio/provider-registry";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { sealCreds } from "../creds";
import { type AccountTypeStatusView, buildProviderStatusView } from "../provider-status";
import { requireAuth } from "../require-auth";

const log = getLogger(["folio", "web", "providers"]);

// 账户类型管理(ADR 0009 ③):状态视图 / 启用(选中 + 可带自定义 settings)/ 改设置。
// 红线:settings 值(哪怕密文)绝不回客户端;seal 在此、open 只在 provider-config.ts 取数时。

const candidates = buildCandidates(ALL_ENTRIES);

const envHas = (name: string): boolean =>
  Boolean((env as unknown as Record<string, unknown>)[name]);

function entryOf(providerId: string) {
  for (const list of candidates.values()) {
    const hit = list.find((e) => e.manifest.id === providerId);
    if (hit) return hit;
  }
  throw new Error(`Unknown provider: ${providerId}`);
}

// 校验(按 manifest.configSchema 的 validator)→ seal(secret 加密)→ JSON。
async function sealSettings(providerId: string, settings: Record<string, string>): Promise<string> {
  const entry = entryOf(providerId);
  await validateCredentials(entry.manifest.configSchema, settings); // 不合规抛
  const specs = entry.manifest.configSchema.map((i) => ({
    key: i.key,
    type: i.type,
    label: i.label,
  }));
  return JSON.stringify(await sealCreds(specs, settings, env.SECRETS_KEY));
}

export const listProviderStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async (): Promise<AccountTypeStatusView[]> => {
    const rows = await createProviderConfigStore(env).getAll();
    return buildProviderStatusView(candidates, rows, envHas);
  });

// 启用 = 该 type 的选中(store.enable 原子退位同类其它 true 行)。settings 可选:
// 不给 = 用内置默认(envDefaults 槽)/沿用已存自定义;给 = 校验 + seal 后一并写。
export const enableProvider = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    z.object({
      providerId: z.string().min(1),
      settings: z.record(z.string(), z.string()).optional(),
    }),
  )
  .handler(async ({ data }) => {
    const entry = entryOf(data.providerId);
    const sealed = data.settings ? await sealSettings(data.providerId, data.settings) : undefined;
    await createProviderConfigStore(env).enable(
      data.providerId,
      entry.manifest.accountType,
      sealed,
    );
    log.info("provider enabled", { providerId: data.providerId, type: entry.manifest.accountType });
  });

// 改设置(不动启停):null = 清自定义、回落内置默认。
export const putProviderSettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(
    z.object({
      providerId: z.string().min(1),
      settings: z.record(z.string(), z.string()).nullable(),
    }),
  )
  .handler(async ({ data }) => {
    const entry = entryOf(data.providerId);
    const sealed = data.settings ? await sealSettings(data.providerId, data.settings) : null;
    await createProviderConfigStore(env).putSettings(
      data.providerId,
      entry.manifest.accountType,
      sealed,
    );
    log.info("provider settings updated", {
      providerId: data.providerId,
      cleared: data.settings === null,
    });
  });

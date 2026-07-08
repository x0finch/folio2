import { env } from "cloudflare:workers";
import { type AccountType, validateCredentials } from "@folio/balances";
import { createProviderConfigStore } from "@folio/db";
import { ALL_ENTRIES, buildCandidates } from "@folio/provider-registry";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { sealCreds } from "../creds";
import { type AccountTypeStatusView, buildProviderStatusView } from "../provider-status";
import { requireAuth } from "../require-auth";
import { db } from "./db";

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
  .handler(async ({ context }): Promise<AccountTypeStatusView[]> => {
    const [rows, accounts] = await Promise.all([
      createProviderConfigStore(env).getAll(),
      db.listAccountsByUser(context.userId),
    ]);
    // 每类型未归档账户数(关闭确认提示用)。
    const counts = new Map<AccountType, number>();
    for (const a of accounts) {
      if (a.archivedAt != null) continue;
      const type = a.type as AccountType;
      counts.set(type, (counts.get(type) ?? 0) + 1);
    }
    return buildProviderStatusView(candidates, rows, envHas, counts);
  });

// 关闭账户类型(ADR 0009 ④):停用该 type 的生效 provider + 归档其全部未归档账户(停止同步)。
// UI 侧先经 accountCount 提醒确认;归档可逆(账户页可取消归档,但类型未启用时同步仍跳过)。
export const disableAccountType = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ accountType: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const list = [...candidates.entries()].find(([t]) => t === data.accountType)?.[1];
    if (!list) throw new Error(`Unknown account type: ${data.accountType}`);
    const store = createProviderConfigStore(env);
    const rows = await store.getAll();
    const overrides = new Map(rows.map((r) => [r.providerId, r.enabled]));
    // 停用生效者:true 覆盖行或 manifest 默认者 → 写 enabled=false(覆盖表语义,可回滚)。
    const selected = list.find((e) => overrides.get(e.manifest.id) === true);
    const active =
      selected ??
      list.find((e) => e.manifest.defaultEnabled && overrides.get(e.manifest.id) !== false);
    if (active) await store.disable(active.manifest.id, data.accountType);
    // 归档该类型全部未归档账户(逐个;单用户量级)。
    const accounts = await db.listAccountsByUser(context.userId);
    const targets = accounts.filter((a) => a.type === data.accountType && a.archivedAt == null);
    for (const a of targets) {
      await db.setArchived(context.userId, a.id, true);
    }
    log.info("account type disabled", {
      type: data.accountType,
      providerId: active?.manifest.id,
      archived: targets.length,
    });
    return { archived: targets.length };
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

import { env } from "cloudflare:workers";
import { AccountStore, SettingsStore } from "@folio/db";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { runStore } from "./internal/oracle";
import { requireAuth } from "./internal/require-auth";

// 全局 provider key 是否已配置(只回布尔,绝不回值)。自托管者据此自检 env。
// CEX 用每账户密钥、非全局 key,故不在此列。
export const getProviderKeyStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(() => ({
    ZERION_API_KEY: Boolean(env.ZERION_API_KEY),
    COINSTATS_API_KEY: Boolean(env.COINSTATS_API_KEY),
  }));

// 库里是否已有账户数据(设置页导入前的提醒用):非空则合并式导入前弹一道确认。只回布尔。
export const getDataStats = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }) => ({
    hasData: (await runStore(context.userId, AccountStore, (s) => s.list())).length > 0,
  }));

// per-user 估值设置(Phase 3,#82)。读带缺省(无行 → coingecko / self-first)。
export const getValuationSettings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => runStore(context.userId, SettingsStore, (s) => s.get()));

// 切换估值模式:source-first = 统一采用市场源价、重算当前视图(历史冻结、无需重 sync)。
export const updateValuationSettings = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ mode: z.enum(["self-first", "source-first"]) }))
  .handler(async ({ context, data }) => {
    await runStore(context.userId, SettingsStore, (s) => s.update({ valuationMode: data.mode }));
    return { ok: true };
  });

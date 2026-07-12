import { env } from "cloudflare:workers";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../require-auth";
import { db } from "./db";

// 全局 provider key 是否已配置(只回布尔,绝不回值)。自托管者据此自检 env。
// CEX 用每账户密钥、非全局 key,故不在此列。
export const getKeyStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(() => ({
    ZERION_API_KEY: Boolean(env.ZERION_API_KEY),
    COINSTATS_API_KEY: Boolean(env.COINSTATS_API_KEY),
  }));

// per-user 估值设置(Phase 3,#82)。读带缺省(无行 → coingecko / self-first)。
export const getValuationSettings = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(({ context }) => db.getUserSettings(context.userId));

// 切换估值模式:source-first = 统一采用市场源价、重算当前视图(历史冻结、无需重 sync)。
export const setValuationMode = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ mode: z.enum(["self-first", "source-first"]) }))
  .handler(async ({ context, data }) => {
    await db.updateUserSettings(context.userId, { valuationMode: data.mode });
    return { ok: true };
  });

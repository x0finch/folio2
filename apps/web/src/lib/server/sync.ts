import { syncAccount } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isManual } from "../manual-connector";
import { requireAuth } from "../require-auth";
import { db } from "./db";
import { buildSyncDeps, warmTokensForUser } from "./sync-deps";

// 编排装配在 ./sync-deps(server-only)—— 本文件不引 cloudflare:workers,故这些 server fn 可安全被客户端 import。
// 全量同步由客户端逐账户编排(见 lib/sync-orchestrator),故此处不再有 triggerSync;只留单账户同步 + 状态。
// 只同步单个账户(详情侧栏「单独同步」):取该账户 + 其 raw creds → syncAccount 隔离写快照。
// 归档账户理论上侧栏会禁用此项;即便调用,syncAccount 仍按现有逻辑处理(缺凭据→skipped)。
export const syncOneAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ accountId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const account = await db.getAccountById(context.userId, data.accountId);
    if (!account) throw new Error("account not found");
    // manual 不是同步源(ADR 0018:当下值由 creds 现造,不写快照)。UI 已对 manual 隐藏「同步」;此处防御式跳过。
    if (isManual(account.connectorId)) {
      return { accountId: account.id, ok: false, skipped: true };
    }
    const rawCreds = await db.getRawCreds(context.userId, data.accountId);
    const result = await syncAccount(buildSyncDeps(), context.userId, account, rawCreds);
    getLogger(["folio", "web", "sync"]).info("single account sync", {
      accountId: account.id,
      connectorId: account.connectorId,
      ok: result.ok,
      skipped: result.skipped,
    });
    await warmTokensForUser(context.userId); // 让总览能 cache-only 富化新价
    return result;
  });

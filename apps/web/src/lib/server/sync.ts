import { syncAccount, syncUser } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuth } from "../require-auth";
import { db } from "./db";
import { buildSyncDeps, warmTokensForUser } from "./sync-deps";

// 手动触发同步:遍历该用户全部账户,逐账户隔离写快照。返回每账户 ok/fail,不含任何密钥/明文凭据。
// userId 经 requireAuth 的 withContext 自动带入下游日志(ALS);此处再记一条触发汇总。
// 编排装配在 ./sync-deps(server-only)—— 本文件不引 cloudflare:workers,故 triggerSync 可安全被客户端 import。
export const triggerSync = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .handler(async ({ context }) => {
    const result = await syncUser(buildSyncDeps(), context.userId);
    const ok = result.results.filter((r) => r.ok).length;
    const skipped = result.results.filter((r) => r.skipped).length;
    getLogger(["folio", "web", "sync"]).info("manual sync triggered", {
      accounts: result.results.length,
      ok,
      skipped,
      failed: result.results.length - ok - skipped,
    });
    // 预热代币缓存(best-effort,inline:同步本就耗时,可接受;首次有按需取价的额外延迟)。
    await warmTokensForUser(context.userId);
    return result;
  });

// 只同步单个账户(详情侧栏「单独同步」):取该账户 + 其 raw creds → syncAccount 隔离写快照。
// 归档账户理论上侧栏会禁用此项;即便调用,syncAccount 仍按现有逻辑处理(缺凭据→skipped)。
export const syncOneAccount = createServerFn({ method: "POST" })
  .middleware([requireAuth])
  .validator(z.object({ accountId: z.string().min(1) }))
  .handler(async ({ data, context }) => {
    const account = await db.getAccountById(context.userId, data.accountId);
    if (!account) throw new Error("account not found");
    // manual 不是同步源(ADR 0018:当下值由 creds 现造,不写快照)。UI 已对 manual 隐藏「同步」;此处防御式跳过。
    if (account.connectorId === "manual") {
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

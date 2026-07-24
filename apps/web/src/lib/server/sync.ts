import { syncAccount as syncAccountCore } from "@folio/sync";
import { getLogger } from "@logtape/logtape";
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { isComplete } from "../creds";
import { isManual } from "../manual-connector";
import { type SyncStatusSummary, summarizeSync } from "../sync-status";
import { credentialSpecs } from "./internal/connector-registry";
import { db } from "./internal/db";
import { requireAuth } from "./internal/require-auth";
import { buildSyncDeps, warmTokensForUser } from "./internal/sync-deps";

const syncLog = getLogger(["folio", "web", "sync"]);

// 编排装配在 ./sync-deps(server-only)—— 本文件不引 cloudflare:workers,故这些 server fn 可安全被客户端 import。
// 全量同步由客户端逐账户编排(见 lib/sync-orchestrator),故此处不再有 triggerSync;只留单账户同步 + 状态。

// 只同步单个账户(详情侧栏「单独同步」):取该账户 + 其 raw creds → syncAccountCore 隔离写快照。
// 归档账户理论上侧栏会禁用此项;即便调用,syncAccountCore 仍按现有逻辑处理(缺凭据→skipped)。
export const syncAccount = createServerFn({ method: "POST" })
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
    const result = await syncAccountCore(buildSyncDeps(), context.userId, account, rawCreds);
    syncLog.info("single account sync", {
      accountId: account.id,
      connectorId: account.connectorId,
      ok: result.ok,
      skipped: result.skipped,
    });
    await warmTokensForUser(context.userId); // 让总览能 cache-only 富化新价
    return result;
  });

// 全局同步状态摘要(PageHeader 共享同步面板;每个认证页 loader 消费)。
// 轻量:仅 3 次 D1 读(accounts / raw creds / 最新快照),不做富化/估值。
// 缺凭据判定复用 creds.isComplete + connectors.credentialSpecs(与 listAccounts 同源);派生走纯模块 summarizeSync。
export const getSyncStatus = createServerFn({ method: "GET" })
  .middleware([requireAuth])
  .handler(async ({ context }): Promise<SyncStatusSummary> => {
    const [accounts, rawList, snapshots] = await Promise.all([
      db.listAccountsByUser(context.userId),
      db.listRawCredsByUser(context.userId),
      db.getLatestSnapshotByUser(context.userId),
    ]);
    const rawById = new Map(rawList.map((r) => [r.id, r.creds]));
    const takenAtById = new Map(snapshots.map((s) => [s.snapshot.accountId, s.snapshot.takenAt]));
    const specsByType = credentialSpecs();
    // manual 不是同步源(ADR 0018)→ 不列入同步面板/「立即同步」集,也不显示为「未同步」。
    const syncable = accounts.filter((a) => !isManual(a.connectorId));
    return summarizeSync(
      syncable.map((a) => {
        const raw = rawById.get(a.id);
        const stored: Record<string, string> = raw ? JSON.parse(raw) : {};
        const specs = specsByType[a.connectorId] ?? [];
        return {
          id: a.id,
          label: a.label,
          archivedAt: a.archivedAt,
          complete: isComplete(specs, stored),
          takenAt: takenAtById.get(a.id) ?? null,
        };
      }),
    );
  });

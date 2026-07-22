import { createServerFn } from "@tanstack/react-start";
import { isComplete } from "../creds";
import { isManual } from "../manual-connector";
import { requireAuth } from "../require-auth";
import { type SyncStatusSummary, summarizeSync } from "../sync-status";
import { credentialSpecs } from "./connectors";
import { db } from "./db";

// 全局同步状态摘要(PageHeader 共享同步面板;每个认证页 loader 消费)。
// 轻量:仅 3 次 D1 读(accounts / raw creds / 最新快照),不做富化/估值。
// 缺凭据判定复用 creds.isComplete + connectors.credentialSpecs(与 listMyAccounts 同源);
// 派生逻辑走纯模块 summarizeSync(已单测)。
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
    // manual 不是同步源(ADR 0018:当下值实时由 creds 现造,从不同步)→ 不列入同步面板/「立即同步」集,
    // 也不显示为「未同步」。
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

import { Database } from "@folio/db";
import { Effect } from "effect";
import { isManual } from "@/lib/core/manual";
import { credentialSpecs } from "@/lib/server/connectors/registry";
import { isComplete } from "@/lib/server/creds";
import { summarizeSync } from "./status";

// 全局同步状态摘要(PageHeader 共享同步面板;每个认证页 loader 消费)。
// 轻量:仅 3 次 D1 读(accounts / raw creds / 最新快照),不做富化/估值。
// 缺凭据判定复用 creds.isComplete + connectors.credentialSpecs(与 listAccounts 同源);
// 派生走纯模块 ./status 的 summarizeSync(无 cloudflare env,可脱离 server fn 单测)。
//
// **ok 数的是「真的同步过」,不是「配置齐全」。** 这两者曾被当成一回事:`ok` 只看
// `complete`,`takenAt` 收进来却只喂给 `lastSyncedAt`。于是一个刚加进来、凭据齐全、
// 一次都没拉过数据的账户被算进 ok,面板显示「All synced 2 / 2」,而账户行上明明写着
// 「Never synced」——「我们还没去问」和「问过了,是这个数」在摘要里长得一样。
// 面板的字面是 "Sources synced",所以口径必须是同步过。
export const handleGetSyncStatus = Effect.fn("getSyncStatus")(function* () {
  const { accounts: accountStore, snapshots: snapshotStore } = yield* Database;
  // 三次读互不依赖 → 并发取(以前是 `Promise.all` 上三个各自装配一次的门面调用)。
  const [accounts, rawList, snapshots] = yield* Effect.all(
    [accountStore.list(), accountStore.listRawCreds(), snapshotStore.latest()],
    { concurrency: 3 },
  );
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

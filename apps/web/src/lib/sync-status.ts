// 同步状态读模型(纯 —— 无 cloudflare env,可脱离 server fn 单测)。
// PageHeader 的共享同步面板消费此摘要:ok/总数 + 上次更新 + 失败(缺凭据)来源。
// 归档账户不计入(与 overview / sync-deps 的过滤一致)。

export interface SyncAccountInput {
  id: string;
  label: string;
  /** 归档时间戳(null = 活跃);归档账户不参与同步、不计入摘要。 */
  archivedAt: number | null;
  /** 凭据是否齐全(缺凭据 = 未同步来源,与设计的 status==='missing' 对应)。 */
  complete: boolean;
  /** 该账户最新快照时间(null = 从未同步)。 */
  takenAt: number | null;
}

export interface SyncStatusSummary {
  /** 活跃账户(id + label)——「立即同步」按当前活跃集并发同步。 */
  accounts: { id: string; label: string }[];
  /** 活跃账户总数。 */
  total: number;
  /** 凭据齐全的活跃账户数(= total - failed.length)。 */
  ok: number;
  /** 未同步来源 = 缺凭据的活跃账户。 */
  failed: { id: string; label: string }[];
  /** 全部活跃账户里最新的一次快照时间(null = 全部从未同步)。 */
  lastSyncedAt: number | null;
}

export function summarizeSync(accounts: SyncAccountInput[]): SyncStatusSummary {
  const active = accounts.filter((a) => a.archivedAt == null);
  const failed = active.filter((a) => !a.complete).map((a) => ({ id: a.id, label: a.label }));
  const lastSyncedAt = active.reduce<number | null>(
    (max, a) => (a.takenAt == null ? max : max == null ? a.takenAt : Math.max(max, a.takenAt)),
    null,
  );
  return {
    accounts: active.map((a) => ({ id: a.id, label: a.label })),
    total: active.length,
    ok: active.length - failed.length,
    failed,
    lastSyncedAt,
  };
}

// 同步状态读模型(纯 —— 无 cloudflare env,可脱离 server fn 单测)。
// PageHeader 的共享同步面板消费此摘要:ok/总数 + 上次更新 + 未同步来源(带原因)。
// 归档账户不计入(与 overview / sync-deps 的过滤一致)。
//
// **ok 数的是「真的同步过」,不是「配置齐全」。** 这两者曾被当成一回事:`ok` 只看
// `complete`,`takenAt` 收进来却只喂给 `lastSyncedAt`。于是一个刚加进来、凭据齐全、
// 一次都没拉过数据的账户被算进 ok,面板显示「All synced 2 / 2」,而账户行上明明写着
// 「Never synced」——「我们还没去问」和「问过了,是这个数」在摘要里长得一样。
// 面板的字面是 "Sources synced",所以口径必须是同步过。

// 一个来源没能同步的原因。缺凭据是根因,从未同步是「配置齐全但还没跑过」。
// 不导出:消费方(sync-status.tsx)按字面量比,不需要这个名字。
type SyncFailureReason = "missing-credentials" | "never-synced";

export interface SyncAccountInput {
  id: string;
  label: string;
  /** 归档时间戳(null = 活跃);归档账户不参与同步、不计入摘要。 */
  archivedAt: number | null;
  /** 凭据是否齐全(与设计的 status==='missing' 对应)。 */
  complete: boolean;
  /** 该账户最新快照时间(null = 从未同步)。 */
  takenAt: number | null;
}

export interface SyncStatusSummary {
  /** 活跃账户(id + label)——「立即同步」按当前活跃集并发同步。 */
  accounts: { id: string; label: string }[];
  /** 活跃账户总数。 */
  total: number;
  /** **已同步过**且凭据齐全的活跃账户数(= total - failed.length)。 */
  ok: number;
  /** 未同步来源 + 原因。 */
  failed: { id: string; label: string; reason: SyncFailureReason }[];
  /** 全部活跃账户里最新的一次快照时间(null = 全部从未同步)。 */
  lastSyncedAt: number | null;
}

// 两个毛病都有时只报根因:凭据没配齐,「从未同步」是它的后果,分两条说会让用户以为有两件事要修。
const failureOf = (a: SyncAccountInput): SyncFailureReason | null =>
  !a.complete ? "missing-credentials" : a.takenAt == null ? "never-synced" : null;

export function summarizeSync(accounts: SyncAccountInput[]): SyncStatusSummary {
  const active = accounts.filter((a) => a.archivedAt == null);
  const failed = active.flatMap((a) => {
    const reason = failureOf(a);
    return reason ? [{ id: a.id, label: a.label, reason }] : [];
  });
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

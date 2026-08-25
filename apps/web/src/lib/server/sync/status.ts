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

// 「多久没同步算旧」。7 天:同步是手动动作,隔几天不点很正常;超过一周,首页那个总资产
// 大概已经不是今天的数了 —— 而那件事此前**在汇总里没有任何数字反映**(#527 裁定 8)。
//
// 阈值必然是拍的。选它的判据是「用户会不会觉得被烦」而不是任何上游约束,所以放在这里、写明
// 是拍的,而不是伪装成一条推导出来的常数。
export const STALE_AFTER_MS = 7 * 24 * 60 * 60 * 1000;

export interface SyncStatusSummary {
  /** 活跃账户(id + label)——「立即同步」按当前活跃集并发同步。 */
  accounts: { id: string; label: string }[];
  /** 活跃账户总数。 */
  total: number;
  /** **已同步过**且凭据齐全的活跃账户数(= total - failed.length)。 */
  ok: number;
  /** 未同步来源 + 原因。 */
  failed: { id: string; label: string; reason: SyncFailureReason }[];
  /**
   * **同步过、但数早了**的来源(超过 `STALE_AFTER_MS`)。
   *
   * 与 `failed` 各归各的:那些是「没有数」,这些是「有数,只是旧」——所以它们仍然计入 `ok`。
   * 分开列是因为两者的下一步动作不同:一个要去补配置,一个只要点一下同步。
   */
  stale: { id: string; label: string; takenAt: number }[];
  /** 全部活跃账户里最新的一次快照时间(null = 全部从未同步)。 */
  lastSyncedAt: number | null;
}

// 两个毛病都有时只报根因:凭据没配齐,「从未同步」是它的后果,分两条说会让用户以为有两件事要修。
const failureOf = (a: SyncAccountInput): SyncFailureReason | null =>
  !a.complete ? "missing-credentials" : a.takenAt == null ? "never-synced" : null;

// `now` 是显式参数,不在函数里读时钟:这一层要断言「恰好卡在阈值上」这种精确边界,
// 而读墙钟的测试是 flaky 的(CODING.md「别断言墙上时钟」)。handler 从 Effect 的 Clock 取。
export function summarizeSync(accounts: SyncAccountInput[], now: number): SyncStatusSummary {
  const active = accounts.filter((a) => a.archivedAt == null);
  const failed = active.flatMap((a) => {
    const reason = failureOf(a);
    return reason ? [{ id: a.id, label: a.label, reason }] : [];
  });
  // 只在「有数」的那些里挑旧的 —— 缺凭据/从未同步的已经在 failed 里,再报一遍等于说两件事要修。
  const stale = active.flatMap((a) =>
    failureOf(a) === null && a.takenAt != null && now - a.takenAt > STALE_AFTER_MS
      ? [{ id: a.id, label: a.label, takenAt: a.takenAt }]
      : [],
  );
  const lastSyncedAt = active.reduce<number | null>(
    (max, a) => (a.takenAt == null ? max : max == null ? a.takenAt : Math.max(max, a.takenAt)),
    null,
  );
  return {
    accounts: active.map((a) => ({ id: a.id, label: a.label })),
    total: active.length,
    ok: active.length - failed.length,
    failed,
    stale,
    lastSyncedAt,
  };
}

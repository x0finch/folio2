import type { SyncRoundAccountStatus, SyncRoundRecord, SyncRoundTrigger } from "@folio/db";

export {
  accountSyncStatus,
  isSyncableAccount,
  STALE_SYNC_MS,
  type SyncAccountInput,
  type SyncAttentionSource,
  type SyncStatusSummary,
  summarizeSync,
} from "@/lib/core/sync-status";

// 一轮的下场三选一。**中断不是一种失败** —— 它是「没人再往下跑了」,连结果都没有。
// 不单独导出:它只作为 `SyncRoundView.state` 出现,而那个接口是导出的。
type SyncRoundState = "running" | "interrupted" | "done";

export interface SyncRoundFailure {
  accountId: string;
  /** 开轮那一刻冻下来的展示名(服务端只按 id 记结果)。 */
  label: string;
  error: string;
}

/** 面板读到的那一份。轮询只拉这个 —— 它是这条链路上唯一在变的东西。 */
export interface SyncRoundView {
  roundId: string;
  state: SyncRoundState;
  trigger: SyncRoundTrigger;
  startedAt: number;
  finishedAt: number | null;
  /**
   * 这一轮的条数 —— 进行中那句 `x / N` 的 N。**收官后不含 `unresolved` 那几条**:
   * 报告只说真跑过的(轮中被归档的账户,它的结果永远不来)。
   */
  total: number;
  /** 已经有结果的条数 —— 那句 `x / N` 的 x。 */
  settled: number;
  /**
   * 三段式的第一段(ADR 0048 裁定 7)。**只数这一轮真同步成功的** ——
   * 面板显示时再加上手记那些不参与同步的来源,两笔各自诚实,不在这一层混。
   */
  synced: number;
  /** 第二段。逐条列出来,面板要点得进去。 */
  failed: SyncRoundFailure[];
  /** 第三段:凭据还没填完的。既不算成功也不算失败。 */
  needsKeys: number;
  /** 还没轮到的第一个账户 —— 进行中那句「正在同步谁」。 */
  current: string | null;
  /** 收官时还 pending 的条数(轮中被归档的那些)—— 不进面板,cron 的收官日志念它。 */
  unresolved: number;
  /** 整轮没跑起来那一句(取账户 / 取凭据挂了)。逐账户的失败不在这里。 */
  error: string | null;
}

// 失败但上游一句话都没留下时的兜底。面板那一行右边是空的话,读的人只会以为界面坏了。
const UNKNOWN_FAILURE = "sync failed";

/**
 * 把库里那份轮记录念成面板要的形状。
 *
 * **活轮判据一句话:未收官且未过期。**过期用 `<=` —— `expiresAt` 是「活到这一刻为止」,
 * 与开轮那条覆盖条件同一个口径,两处必须一致,否则会出现「开得了新轮但面板还说旧轮在跑」。
 *
 * `now` 是显式参数(与 `summarizeSync` 同款理由):这一层要断言精确边界,读墙钟的测试是 flaky 的。
 */
export function syncRoundView(round: SyncRoundRecord, now: number): SyncRoundView {
  const entries = Object.entries(round.accounts);
  const tally: Record<SyncRoundAccountStatus, number> = {
    pending: 0,
    synced: 0,
    failed: 0,
    "needs-keys": 0,
  };
  const failed: SyncRoundFailure[] = [];
  let current: string | null = null;
  for (const [accountId, a] of entries) {
    tally[a.status] += 1;
    if (a.status === "pending") current ??= a.label;
    if (a.status === "failed") {
      failed.push({ accountId, label: a.label, error: a.error || UNKNOWN_FAILURE });
    }
  }
  const state: SyncRoundState =
    round.finishedAt != null ? "done" : now >= round.expiresAt ? "interrupted" : "running";
  // 收官后还 pending 的只有一种来路:轮中被归档 / 删除的账户 —— 内核的名单是跑的那一刻现算的,
  // 它的 settle 永远不来。**报告只说真跑过的**:留在分母里,`9 synced` 对 `10` 永远差一个,
  // 读起来像少同步了一个来源,而那个来源已经不存在了。剔掉的条数记进 `unresolved` 供日志。
  // 在跑 / 中断的轮不剔:那时 pending 是「还没轮到」,分母就该是全名单。
  const unresolved = state === "done" ? tally.pending : 0;
  return {
    roundId: round.roundId,
    state,
    trigger: round.trigger,
    startedAt: round.startedAt,
    finishedAt: round.finishedAt,
    total: entries.length - unresolved,
    settled: entries.length - tally.pending,
    synced: tally.synced,
    unresolved,
    failed,
    needsKeys: tally["needs-keys"],
    current,
    error: round.error ?? null,
  };
}

// 纯逻辑(无 server-only / React import → 可单测)。并发编排逐个账户同步,持续报告进度。
// 全量同步无单一原子入口(给不了增量进度)→ 客户端逐个跑 worker(= syncAccount server fn),
// 并发封顶,每次状态变化回调 onProgress,供同步入口实时读进度 tooltip。设计见 PRD 02。

export interface SyncItem {
  accountId: string;
  label: string;
}
export interface SyncProgress {
  total: number;
  done: number; // 已完成(含失败)
  inFlight: string[]; // 正在同步的账户 label
  failures: { label: string; error: string }[];
}

// 以 concurrency 为上限的工作池:任一时刻在飞不超过 concurrency;每个 item 跑一次 worker(抛错=失败,
// 收集但不中断其余);每次状态变化调 onProgress;全部完成后 resolve 最终进度。worker 注入(测试给假的)。
export async function orchestrateSync(
  items: readonly SyncItem[],
  worker: (accountId: string) => Promise<void>,
  opts: { concurrency?: number; onProgress?: (p: SyncProgress) => void } = {},
): Promise<SyncProgress> {
  const concurrency = Math.max(1, opts.concurrency ?? 3);
  const progress: SyncProgress = { total: items.length, done: 0, inFlight: [], failures: [] };
  const emit = () => opts.onProgress?.({ ...progress, inFlight: [...progress.inFlight] });
  emit();
  if (items.length === 0) return progress;

  let next = 0;
  async function run(): Promise<void> {
    while (next < items.length) {
      const item = items[next++];
      if (!item) break;
      progress.inFlight.push(item.label);
      emit();
      try {
        await worker(item.accountId);
      } catch (err) {
        progress.failures.push({
          label: item.label,
          error: err instanceof Error ? err.message : String(err),
        });
      } finally {
        const i = progress.inFlight.indexOf(item.label);
        if (i >= 0) progress.inFlight.splice(i, 1);
        progress.done++;
        emit();
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => run()));
  return progress;
}

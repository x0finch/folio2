import type { QueryClient } from "@tanstack/react-query";
import { syncAccount } from "@/lib/server/sync";
import type { SyncAccountStart } from "@/lib/server/sync/run";
import type { SyncRoundView } from "@/lib/server/sync/status";
import { POLL_INTERVAL } from "./constants";
import { syncKeys } from "./keys";
import { syncRoundQuery } from "./sync-round";

// **单账户同步在前端这一侧:发起,然后等那一轮里「它」落账**(FOL-89)。
//
// `syncAccount` 不再在请求里同步(那会把出网与重估全压进一次调用的 10ms CPU),而是把账户排进它所属
// 组合的一轮、投一条队列消息就返回。所以「同步完了没有、结果是什么」要从那一轮里读 —— 与页头面板
// 读的是同一个 `getSyncRound`,只是这里盯的是**一个账户**的那一格(`SyncRoundView.statuses`)。
//
// 返回形状与以前 `syncAccount` 的内联结果一致(`ok` / `skipped` / `skipReason` / `error`),
// 于是调用方的 toast 分支一个都不用改,只是 await 的时间变长了 —— 它们的 pending 态就是「在同步」。

/** 等到的结果 —— 与 `syncAccount` 当场就答得出的那几种同一个形状。 */
export type AccountSyncOutcome = Extract<SyncAccountStart, { queued: false }>["result"];

/**
 * 等多久就不等了(毫秒)。正常是秒级;最坏是队列重投三次(`retry_delay` 30s)再加心跳过期 ——
 * 那时服务端的轮早已念成「中断」,这里读得到。这条上限只防服务端一直不给答案时前端永远挂着。
 */
const ACCOUNT_SYNC_TIMEOUT_MS = 5 * 60_000;

/**
 * 从一轮里念出**这个账户**的下场;还没落账 → `null`(接着等)。纯函数,单测直接喂轮。
 *
 *   · 轮没了 / 键上已换成别的轮 → 静默跳过:结果被下一轮盖掉了,读不回来,但数据已经落库(调用方照样刷新)。
 *   · 轮中断了还没轮到它 → 失败(没有上游原话,调用方给通用那句)。
 *   · 轮收官了它还 pending → 跳过:只可能是轮中被归档 / 删掉,它的结果永远不来。
 */
export function accountOutcomeIn(
  view: SyncRoundView | null,
  roundId: string,
  accountId: string,
): AccountSyncOutcome | null {
  if (view == null || view.roundId !== roundId) return { accountId, ok: false, skipped: true };
  switch (view.statuses[accountId]) {
    case "synced":
      return { accountId, ok: true };
    case "needs-keys":
      return { accountId, ok: false, skipped: true, skipReason: "missing-credentials" };
    case "skipped":
      return { accountId, ok: false, skipped: true };
    case "failed":
      return {
        accountId,
        ok: false,
        error: view.failed.find((f) => f.accountId === accountId)?.error,
      };
    default:
      if (view.state === "running") return null;
      if (view.state === "interrupted") return { accountId, ok: false };
      return { accountId, ok: false, skipped: true };
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * 发起单账户同步,**等到这个账户在那一轮里落账**再 resolve。
 *
 * 发起的回包就是那一轮此刻的样子 —— 先落进 `syncKeys.round` 的缓存(与 `useSyncRound` 发起时同一个
 * 手法:先取消在飞的那发旧读),页头胶囊立刻转起来、它自己的轮询也跟着开。这里再按同一个间隔
 * 读那一轮,直到念得出结果。**发起本身失败才 reject**(网络、NotFound);同步失败是一个 `ok: false`。
 */
export async function syncAccountAndWait(
  queryClient: QueryClient,
  accountId: string,
  opts: { pollMs?: number; timeoutMs?: number } = {},
): Promise<AccountSyncOutcome> {
  const start = await syncAccount({ data: { accountId } });
  if (!start.queued) return start.result;
  const { portfolioId, roundId } = start;
  await queryClient.cancelQueries({ queryKey: syncKeys.round(portfolioId) });
  queryClient.setQueryData(syncKeys.round(portfolioId), start.round);

  const pollMs = opts.pollMs ?? POLL_INTERVAL.syncRound;
  const deadline = Date.now() + (opts.timeoutMs ?? ACCOUNT_SYNC_TIMEOUT_MS);
  let view: SyncRoundView | null = start.round;
  for (;;) {
    const outcome = accountOutcomeIn(view, roundId, accountId);
    if (outcome) return outcome;
    if (Date.now() >= deadline) return { accountId, ok: false };
    await sleep(pollMs);
    view = await queryClient.fetchQuery({ ...syncRoundQuery(portfolioId), staleTime: 0 });
  }
}

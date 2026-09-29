import type { QueryClient } from "@tanstack/react-query";
import { SYNC_RETRY_CHAIN_MS } from "@/lib/server/jobs/constants";
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

/** 在重投链最坏耗时之外再多等多久:排队派发与轮询间隔的余量。 */
const ACCOUNT_SYNC_TIMEOUT_MARGIN_MS = 60_000;

/**
 * 等多久就不等了(毫秒)。正常是秒级;最坏是整条重投链(`SYNC_RETRY_CHAIN_MS`:4 次投递各跑满预算,
 * 中间 3 个重投间隔,约 440s)—— 消费者每次投递前都续心跳,重投期间轮一直是「在跑」,所以这条上限
 * **必须比整条链长**,否则前端先放弃、报一句通用的失败,服务端过后才把账户落成 synced / failed
 * (review R2-#3)。从服务端同一组常量推,再加一截余量;超过它只可能是服务端一直不给答案(消息丢了、
 * 队列积压),这时别让前端永远挂着。
 */
export const ACCOUNT_SYNC_TIMEOUT_MS = SYNC_RETRY_CHAIN_MS + ACCOUNT_SYNC_TIMEOUT_MARGIN_MS;

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

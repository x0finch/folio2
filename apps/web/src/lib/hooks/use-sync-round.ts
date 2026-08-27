import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { syncKeys } from "@/lib/queries/keys";
import { invalidateFor } from "@/lib/queries/refresh";
import { syncRoundQuery } from "@/lib/queries/sync";
import type { SyncRoundView } from "@/lib/server/sync/status";

// 一轮同步在前端这一侧只剩两件事:**发起它**,和**读它**(ADR 0048)。
//
// 以前这里有一整套:模块级的轮 store(每组合一格)、从 mutationCache 侧面问出来的 busy、
// 随 mutation variables 走的展示名表与刷新节流器、以及一个 NDJSON 流读取器。它们全都是
// 「进度记在浏览器里」这个错位的补丁 —— 跨页要活、跨组合别互踩、刷新别失忆。进度搬到服务端
// 之后,那些问题连提都提不出来:换页重新读一次就是了,而 cron 跑的轮也终于看得见。
//
// 节流器也一并没了:它管的是「一秒钟连刷好几次」,而现在进度本来就 1.5s 才前进一格 ——
// 轮询间隔自己就是那个节流。

/** 在跑 = 未收官且心跳还在。判据在服务端(`syncRoundView`),这里只是把它念出来。 */
export const isRoundBusy = (round: SyncRoundView | null | undefined): boolean =>
  round?.state === "running";

export interface SyncRoundHandle {
  /** 这个组合最近一轮;从没同步过 → null。 */
  round: SyncRoundView | null;
  busy: boolean;
  /** 点了也没用的时候 —— 正在跑、请求在飞、或者这个组合没有可同步的账户。 */
  disabled: boolean;
  /** **发起**同步这个请求本身失败了。与「这一轮里某个账户失败了」是两回事。 */
  startError: string | null;
  sync: () => void;
}

export function useSyncRound(portfolioId: string, syncableCount: number): SyncRoundHandle {
  const queryClient = useQueryClient();
  const { data } = useQuery(syncRoundQuery(portfolioId));
  const round = data ?? null;
  const busy = isRoundBusy(round);

  const mutation = useMutation({
    mutationFn: async (): Promise<SyncRoundView> => {
      // **只递「我在看哪个组合」,不递账户名单**(ADR 0047):跑哪些账户由服务端按这个组合算。
      const response = await fetch("/api/sync", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ portfolioId }),
      });
      if (!response.ok) throw new Error(`sync failed: ${response.status}`);
      return (await response.json()) as SyncRoundView;
    },
    // 服务端刚回的那一份就是此刻的事实 —— 直接落进缓存,面板不必空等第一次轮询(1.5s)。
    onSuccess: (view) => queryClient.setQueryData(syncKeys.round(portfolioId), view),
  });

  // 进度前进一格 → 定向刷新数据域(余额、账户行、摘要)。
  //
  // **按「轮 id + 已完成数 + 状态」比,不按对象引用**:react-query 的结构共享确实会在数据没变时
  // 保留同一个引用,但那是它的实现细节 —— 靠它等于把「多久刷一次首页」交给别处的一个优化。
  // **首次看见也不刷**:那只是「页面加载时这里有一轮旧记录」,数据本来就是新的。
  const seen = useRef<string | null>(null);
  useEffect(() => {
    if (!round) return;
    const mark = `${round.roundId}:${round.settled}:${round.state}`;
    if (seen.current === null) {
      seen.current = mark;
      return;
    }
    if (seen.current === mark) return;
    seen.current = mark;
    void invalidateFor(queryClient, "sync.round");
  }, [round, queryClient]);

  const disabled = busy || mutation.isPending || syncableCount === 0;

  return {
    round,
    busy,
    disabled,
    startError: mutation.error ? mutation.error.message : null,
    sync: () => {
      if (disabled) return;
      mutation.mutate();
    },
  };
}

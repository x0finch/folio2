import { queryOptions } from "@tanstack/react-query";
import { getSyncRound, getSyncStatus } from "@/lib/server/sync";
import { POLL_INTERVAL, RETRY, STALE_TIME, shouldRetry } from "./constants";
import { syncKeys } from "./keys";

// 同步域的读取入口 —— 与 `lib/server/sync` 的读取型 server fn 一一对应。
// 「这一页要什么数据」从路由文件挪到了这里(ADR 0038 的取舍),一个域一个文件。

// 同步域没有独立的写操作:它由「一轮同步」刷新,而那条路径本片就迁好了 ——
// 所以 staleTime 可以直接开,不用等别的片。
// 按 Portfolio 一份:切组合时 key 变 → 重新取一份该视图的摘要(ADR 0033)。前缀仍是
// `["sync","status"]`,所以刷新映射表那条域前缀照样盖得住全部。
export const syncStatusQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: syncKeys.status(portfolioId),
    queryFn: () => getSyncStatus({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
    // 外壳靠它才画得出来,所以**不放弃**(同 portfolioListQuery 的理由)。
    retry: (failureCount, error) => shouldRetry(failureCount, error, RETRY.forever),
  });

/**
 * 这个组合最近一轮同步(ADR 0048)。**busy 时自己轮询,闲时一发都不发** ——
 * `refetchInterval` 收函数,按当前数据决定,所以「什么时候该盯着」这件事住在查询里,
 * 不必让某个组件攒一份 state 再去开关定时器。
 *
 * `staleTime: 0`:这份数据每 1.5s 就可能变,缓存久了等于拿旧进度画进度条。
 */
export const syncRoundQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: syncKeys.round(portfolioId),
    queryFn: () => getSyncRound({ data: { portfolioId } }),
    refetchInterval: (query) =>
      query.state.data?.state === "running" ? POLL_INTERVAL.syncRound : false,
    staleTime: 0,
  });

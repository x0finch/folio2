import { queryOptions } from "@tanstack/react-query";
import { getSyncRound } from "@/lib/server/sync";
import { POLL_INTERVAL } from "./constants";
import { syncKeys } from "./keys";

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

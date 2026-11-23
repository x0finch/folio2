import { queryOptions } from "@tanstack/react-query";
import { getSyncRound } from "@/lib/server/sync";
import { POLL_INTERVAL } from "./constants";
import { syncKeys } from "./keys";

/**
 * The portfolio's latest sync round. Polls while busy and not when idle: `refetchInterval` takes a function
 * of the current data. `staleTime: 0` because the data can change every 1.5 s.
 */
export const syncRoundQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: syncKeys.round(portfolioId),
    queryFn: () => getSyncRound({ data: { portfolioId } }),
    refetchInterval: (query) =>
      query.state.data?.state === "running" ? POLL_INTERVAL.syncRound : false,
    staleTime: 0,
  });

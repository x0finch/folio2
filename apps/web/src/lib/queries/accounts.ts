import { queryOptions } from "@tanstack/react-query";
import type { HistoryRange } from "@/lib/core/history-range";
import { type JsonBody, readJson } from "@/lib/core/json-response";
import type { AccountHoldingsView } from "@/lib/core/portfolio";
import { getAccountHistory, listAccounts } from "@/lib/server/accounts";
import { getTokenValueHistory } from "@/lib/server/holdings";
import { getManualAccount } from "@/lib/server/manual-tokens";
import { RETRY, STALE_TIME, shouldRetry } from "./constants";
import { accountKeys } from "./keys";

// `portfolioId` must be a real id, not undefined-means-default: otherwise the loader's prefetch
// and the component's read use different keys and the first paint fetches twice.
export const accountListQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: accountKeys.list(portfolioId),
    queryFn: async () => readJson(await listAccounts({ data: { portfolioId } })),
    staleTime: STALE_TIME.live,
    // The shell suspends on this outside any island boundary; giving up would throw the whole
    // authed shell into `StalledShell`, which `reset` can't recover.
    retry: (failureCount, error) => shouldRetry(failureCount, error, RETRY.forever),
  });

export type AccountListItem = JsonBody<Awaited<ReturnType<typeof listAccounts>>>[number];
export type AccountHoldings = AccountHoldingsView;

/**
 * The window stays in the key and goes to the server: it bounds the payload, otherwise the endpoint
 * would send every point ever stored.
 */
export const accountHistoryQuery = (args: {
  accountId: string;
  /** The key uses this, not the computed `since`. */
  range: HistoryRange;
  /** undefined for "all". */
  since: number | undefined;
  connectorId: AccountListItem["connectorId"];
}) =>
  queryOptions({
    queryKey: accountKeys.history(args.accountId, args.range),
    // connectorId saves the server an account lookup; it's derived from accountId, so it stays
    // out of the key.
    queryFn: async () =>
      readJson(
        await getAccountHistory({
          data: {
            accountId: args.accountId,
            since: args.since,
            connectorId: args.connectorId,
            range: args.range,
          },
        }),
      ),
    staleTime: STALE_TIME.history,
  });

export const holdingHistoryQuery = (args: {
  holdingKey: string;
  range: HistoryRange;
  since: number | undefined;
}) =>
  queryOptions({
    queryKey: accountKeys.holdingHistory(args.holdingKey, args.range),
    queryFn: async () =>
      readJson(
        await getTokenValueHistory({
          data: { key: args.holdingKey, since: args.since, range: args.range },
        }),
      ),
    staleTime: STALE_TIME.history,
  });

export const manualAccountQuery = (accountId: string) =>
  queryOptions({
    queryKey: accountKeys.manualDetail(accountId),
    queryFn: () => getManualAccount({ data: { accountId } }),
    staleTime: STALE_TIME.live,
  });

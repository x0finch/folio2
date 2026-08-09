import { queryOptions } from "@tanstack/react-query";
import { getAccountHistory, listAccounts } from "../server/accounts";
import { getHoldingHistory } from "../server/holdings";
import { getManualAccount } from "../server/manual-tokens";
import { listAccountHoldings } from "../server/portfolio";
import { STALE_TIME } from "./constants";
import { accountKeys } from "./keys";

// 账户域的读取入口 —— 与 `lib/server/accounts.ts` / `holdings.ts` / `manual-tokens.ts` 及
// `portfolio.ts` 里那个按账户的读取 server fn 对应。
//
// **列表与持仓的 `staleTime` 在 #414 打开**:账户与手记资产的写路径已经全部改成定向刷新。
//
// 三条历史/明细查询**保留各自原有的 `staleTime`**:它们本来就是 react-query 查询、本来就带缓存,
// 这一片只是把 key 收进分层约定,不改它们的时效行为(改了就是趁迁移夹带,评审时也看不出来为什么)。

export const accountListQuery = () =>
  queryOptions({
    queryKey: accountKeys.list(),
    queryFn: () => listAccounts(),
    staleTime: STALE_TIME.live,
  });

export const accountHoldingsQuery = () =>
  queryOptions({
    queryKey: accountKeys.holdings(),
    queryFn: () => listAccountHoldings(),
    staleTime: STALE_TIME.live,
  });

/** 一份账户列表行的形状(含归档账户与凭据投影)。 */
export type AccountListItem = Awaited<ReturnType<typeof listAccounts>>[number];
/** 按账户的持仓视图(活跃账户 + 其最新快照的富化持仓)。 */
export type AccountHoldings = Awaited<ReturnType<typeof listAccountHoldings>>;

export const accountHistoryQuery = (args: {
  accountId: string;
  /** 窗口档位("30d" 等)——**进 key 的是它**,不是下面那个现算的起点。 */
  range: string;
  /** 起点(`"all"` 窗口下为 undefined = 不限)。 */
  since: number | undefined;
  connectorId: AccountListItem["connectorId"];
}) =>
  queryOptions({
    queryKey: accountKeys.history(args.accountId, args.range),
    // connectorId 传给服务端做读路径分流(manual→账本 / 其余→快照),省一次账户反查。
    // 它由 accountId 决定,所以不进 key —— 进了只会让同一账户凭空多出一条永不命中的缓存。
    queryFn: () =>
      getAccountHistory({
        data: { accountId: args.accountId, since: args.since, connectorId: args.connectorId },
      }),
    staleTime: 60_000,
  });

export const holdingHistoryQuery = (args: {
  holdingKey: string;
  range: string;
  since: number | undefined;
}) =>
  queryOptions({
    queryKey: accountKeys.holdingHistory(args.holdingKey, args.range),
    queryFn: () => getHoldingHistory({ data: { key: args.holdingKey, since: args.since } }),
    staleTime: 60_000,
  });

export const manualAccountQuery = (accountId: string) =>
  queryOptions({
    queryKey: accountKeys.manualDetail(accountId),
    queryFn: () => getManualAccount({ data: { accountId } }),
    staleTime: 30_000,
  });

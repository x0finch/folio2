import { queryOptions } from "@tanstack/react-query";
import type { HistoryRange } from "@/lib/core/history-range";
import type { AccountHoldingsView } from "@/lib/core/portfolio";
import { getAccountHistory, listAccounts } from "@/lib/server/accounts";
import { getTokenValueHistory } from "@/lib/server/holdings";
import { getManualAccount } from "@/lib/server/manual-tokens";
import { RETRY, STALE_TIME, shouldRetry } from "./constants";
import { accountKeys } from "./keys";

// 账户域的读取入口 —— 与 `lib/server/accounts` / `holdings` / `manual-tokens` 对应。
//
// **列表的 `staleTime` 在 #414 打开**:账户与手记资产的写路径已经全部改成定向刷新。
// 持仓明细由原子快照 + 富化在浏览器合并(`useAccountHoldingsView`,FOL-55)。
//
// 三条历史/明细查询的时效**数值**与迁移前一致,但档位走 `STALE_TIME`(不就地写数字):
// 历史曲线归 `history`(按天聚合,只有最右一个点会动),手记明细归 `live`(和账户行同性质,
// 由 `account.write` 刷)。就地写数字会让 `STALE_TIME` 这张表被绕过 —— 它存在的意义就是
// 「多久算旧」按数据自身性质分档,而不是各查询各写一个数。

// 这三条**按组合各一份**(ADR 0047:服务端已按组合筛)。`portfolioId` 必须是真实 id,
// 不能靠「缺省 = 默认」的 undefined —— loader 预取的那份与组件读的那份 key 对不上,首屏白拉一遍。
export const accountListQuery = (portfolioId: string) =>
  queryOptions({
    queryKey: accountKeys.list(portfolioId),
    queryFn: () => listAccounts({ data: { portfolioId } }),
    staleTime: STALE_TIME.live,
    // **外壳赖以存在的读,永不认命重试**(FOL-58 回归修复):页头同步胶囊 `useSyncStatus` 在
    // `ShellWithSync`——任何 island 边界之外——suspend 在这条(+ 快照 `now`)上。默认 5 次失败后
    // react-query 会抛,整个 authed 壳掀进 `StalledShell`,而那里的 `reset` 救不回来(见
    // constants.ts `RETRY.forever` 说明)。老 `syncStatusQuery` 就是靠 forever 兜的,收口后这条得接上。
    retry: (failureCount, error) => shouldRetry(failureCount, error, RETRY.forever),
  });

/** 一份账户列表行的形状(含该组合的归档账户、归属与凭据投影)。 */
export type AccountListItem = Awaited<ReturnType<typeof listAccounts>>[number];
/** 按账户的持仓视图(浏览器原子 query 合并:现价重算的总额/持仓 + 两端相减的 24h 盈亏)。 */
export type AccountHoldings = AccountHoldingsView;

/**
 * 一个窗口的原料点(FOL-38:接口发点、浏览器画线)。**窗口仍然进 key、仍然回服务器一趟** ——
 * 它是那条接口的上界:发的是原样的点,不按窗口裁的话「攒了多久就发多大」。
 */
export const accountHistoryQuery = (args: {
  accountId: string;
  /** 窗口档位("30d" 等)——**进 key 的是它**,不是下面那个现算的起点。 */
  range: HistoryRange;
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
        data: {
          accountId: args.accountId,
          since: args.since,
          connectorId: args.connectorId,
          range: args.range,
        },
      }),
    staleTime: STALE_TIME.history,
  });

export const holdingHistoryQuery = (args: {
  holdingKey: string;
  range: HistoryRange;
  since: number | undefined;
}) =>
  queryOptions({
    queryKey: accountKeys.holdingHistory(args.holdingKey, args.range),
    queryFn: () =>
      getTokenValueHistory({
        data: { key: args.holdingKey, since: args.since, range: args.range },
      }),
    staleTime: STALE_TIME.history,
  });

export const manualAccountQuery = (accountId: string) =>
  queryOptions({
    queryKey: accountKeys.manualDetail(accountId),
    queryFn: () => getManualAccount({ data: { accountId } }),
    staleTime: STALE_TIME.live,
  });

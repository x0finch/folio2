import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { pickSelectedPortfolio } from "@/lib/hooks/use-portfolio";
import { accountHoldingsQuery, accountListQuery } from "@/lib/queries/accounts";
import { connectorCatalogQuery } from "@/lib/queries/connectors";
import { portfolioListQuery } from "@/lib/queries/portfolio";
import { accountTagLinksQuery, tagListQuery } from "@/lib/queries/tags";
import { Accounts } from "./-accounts";

export const Route = createFileRoute("/_authed/accounts")({
  // 详情抽屉进 URL(与首页主 tab 同一套,ADR 0043):刷新还停在这个账户、链接能分享。
  // **只校验形状,不校验值** —— 账户 id 是运行时数据(还可能指向已删/不在当前 Portfolio 的账户),
  // 认不出的由组件当作没开,见下面的 `selected`。
  //
  // `.catch(undefined)` 不是装饰:schema 一旦抛错,router 就把它当路由错误,整页变成
  // 「Something went wrong!」外加一坨 zod 报错 JSON。实测(去掉 `.catch` 复现):`?account=`
  // 空串触发 `too_small`,`?account=a&account=b` 被解析成数组触发 `invalid_type` —— 两个都只是
  // 地址栏里敲坏了一个参数,不该把页面打没。`.catch` 把它们收成「没带这个参数」。
  validateSearch: z.object({
    account: z.string().min(1).optional().catch(undefined),
    // 页头同步面板点某一行时带上它:「把这个账户的那一行滚出来」。与 `account` 分开 —— 那个是
    // 「打开详情抽屉」,这个是「在列表里指给我看」;用完即由列表页清掉,不留在地址栏里。
    focus: z.string().min(1).optional().catch(undefined),
  }),
  // 预取的 key 跟着地址里的组合走(ADR 0046 / 0047:这几份数据现在按组合各一份)。
  loaderDeps: ({ search }) => ({ portfolio: search.portfolio }),
  // 账户域的读取已迁 react-query(#413):loader 只**预取**,拼行的活挪进组件。
  // #493 票 2:所有查询第一时间并行发出,谁先回来谁先画。不等持仓、不等标签 ——
  // 那两样是名单上的后到内容,await 它们顶栏就会跟着白着。
  //
  // 只等「是哪个组合」(预取 key 必须对上),其余发出即返回 —— 同首页 / Insights 那两条。
  loader: async ({ context: { queryClient }, deps }) => {
    const { portfolios, defaultId } = await queryClient.ensureQueryData(portfolioListQuery());
    const selectedId = pickSelectedPortfolio(deps.portfolio, portfolios, defaultId);
    // connector 展示名的目录:**本页每一行都有一个徽标**,不预取的话首帧只能显兜底名(#467)。
    // 部署内静态、缓存一次,所以这一条实际只在整个会话的第一次加载上花一趟(与其余几条并行)。
    queryClient.ensureQueryData(connectorCatalogQuery());
    queryClient.ensureQueryData(accountListQuery(selectedId));
    queryClient.ensureQueryData(tagListQuery(selectedId));
    queryClient.ensureQueryData(accountTagLinksQuery(selectedId));
    // 持仓带 24h 盈亏(两端相减现算,FOL-51)—— 不再单独预取一条盈亏。
    queryClient.ensureQueryData(accountHoldingsQuery(selectedId));
  },
  component: Accounts,
});

import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { accountHoldingsQuery, accountListQuery } from "../../lib/queries/accounts";
import { connectorCatalogQuery } from "../../lib/queries/connectors";
import { portfolioMembershipsQuery } from "../../lib/queries/portfolio";
import { accountTagLinksQuery, tagListQuery } from "../../lib/queries/tags";
import { Accounts, AccountsSkeleton } from "./-accounts";

export const Route = createFileRoute("/_authed/accounts")({
  // 详情抽屉进 URL(与首页主 tab 同一套,ADR 0043):刷新还停在这个账户、链接能分享。
  // **只校验形状,不校验值** —— 账户 id 是运行时数据(还可能指向已删/不在当前 Portfolio 的账户),
  // 认不出的由组件当作没开,见下面的 `selected`。
  //
  // `.catch(undefined)` 不是装饰:schema 一旦抛错,router 就把它当路由错误,整页变成
  // 「Something went wrong!」外加一坨 zod 报错 JSON。实测(去掉 `.catch` 复现):`?account=`
  // 空串触发 `too_small`,`?account=a&account=b` 被解析成数组触发 `invalid_type` —— 两个都只是
  // 地址栏里敲坏了一个参数,不该把页面打没。`.catch` 把它们收成「没带这个参数」。
  validateSearch: z.object({ account: z.string().min(1).optional().catch(undefined) }),
  // 账户域的读取已迁 react-query(#413):loader 只**预取**,拼行的活挪进组件 —— 四个来源现在
  // 各自是一条查询、各自的到达时刻不同,拼装得跟着数据走而不是跟着 loader 走。
  loader: async ({ context: { queryClient } }) => {
    await Promise.all([
      // connector 展示名的目录:**本页每一行都有一个徽标**,不预取的话首帧只能显兜底名(#467)。
      // 部署内静态、缓存一次,所以这一条实际只在整个会话的第一次加载上花一趟(与其余几条并行)。
      queryClient.ensureQueryData(connectorCatalogQuery()),
      queryClient.ensureQueryData(accountHoldingsQuery()),
      queryClient.ensureQueryData(accountListQuery()),
      queryClient.ensureQueryData(portfolioMembershipsQuery()),
      queryClient.ensureQueryData(tagListQuery()),
      queryClient.ensureQueryData(accountTagLinksQuery()),
    ]);
  },
  pendingComponent: AccountsSkeleton,
  component: Accounts,
});

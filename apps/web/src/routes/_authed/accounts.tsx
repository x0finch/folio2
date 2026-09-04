import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { pickSelectedPortfolio } from "@/lib/hooks/use-portfolio";
import { portfolioListQuery } from "@/lib/queries/portfolio";
import { prefetchAccounts } from "@/lib/queries/prefetch-pages";
import { Accounts } from "./-accounts";

export const Route = createFileRoute("/_authed/accounts")({
  // 详情抽屉选中(`account`)不再进 URL(FOL-80,反转 ADR 0043):住组件内部 state。
  //
  // 只剩 `focus` 一个自有参数,而且是**一次性命令**不是持久状态:页头同步面板点某一行时跨页带上它
  // (「把这个账户那一行滚出来并高亮」),本页到达后读一次即由列表页 `replace` 抹掉,不留在地址栏里。
  // 它必须走 URL —— 同步面板在别的页(总览/洞察)的页头里,跨页传值只能经地址。
  //
  // `.catch(undefined)` 不是装饰:schema 一旦抛错 router 就当路由错误,整页变「Something went wrong!」。
  // 实测:`?focus=` 空串触发 `too_small`,`?focus=a&focus=b` 解析成数组触发 `invalid_type` —— 都只是
  // 地址栏里敲坏了参数,不该把页面打没。`.catch` 把它们收成「没带这个参数」。
  validateSearch: z.object({
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
    prefetchAccounts(queryClient, selectedId);
  },
  component: Accounts,
});

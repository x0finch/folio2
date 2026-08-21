import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import {
  homeTabStripQuery,
  portfolioGain24hQuery,
  portfolioHistoryQuery,
  portfolioListQuery,
  portfolioOverviewQuery,
} from "@/lib/queries/portfolio";
import { Overview } from "./-home";
import { DEFAULT_TAB } from "./-home/home-tabs";

export const Route = createFileRoute("/_authed/")({
  // 主 tab 进 URL(ADR 0043):刷新还停在原 tab、链接可分享,滚动位置也按 href 分开记(片1)。
  // **这里只校验形状,不校验值** —— 与 insights 的 `dim` 不同(那边合法值是有限集,回落已收进
  // `validateSearch`):这里的合法值含自定义 Tab 的 pin id,是运行时数据,route 层根本不知道有哪些。
  // 所以认不出的值(pin 被删、手写乱码)只能由组件那套 clamp 回落,见 `useHomeTabSelection`。
  // `token` = 打开的代币详情抽屉(哪个币,值是 Holding 的分组键)。同样只校验形状:那个键是
  // 运行时数据(tokenId / `no-token:…`),认不出的由 TokenHoldings 当作没开,见那里的 `selected`。
  //
  // 空串按「没带」处理(`?tab=` 手改出来的),所以是 `.min(1)`。
  //
  // `.catch(undefined)` 是必须的:schema 抛错会被 router 当成路由错误,整页变成
  // 「Something went wrong!」外加一坨 zod 报错 JSON(在 accounts 那条上去掉 `.catch` 实测复现过 ——
  // 空串 `too_small`,重复参数被解析成数组 `invalid_type`)。地址栏里敲坏一个参数不该把页面打没,
  // `.catch` 把这些统一收成「没带这个参数」。
  validateSearch: z.object({
    tab: z.string().min(1).optional().catch(undefined),
    token: z.string().min(1).optional().catch(undefined),
  }),
  // 默认 tab 不写进 URL:`/` 就是 tokens,只有别的 tab 才挂 `?tab=`。交给官方中间件在建地址时统一剥,
  // 而不是每个导航调用点自己记得把默认值抹成 undefined。(`token` 没有默认值,不参与。)
  search: { middlewares: [stripSearchParams({ tab: DEFAULT_TAB })] },
  // 本页的读取**已全部迁到 react-query**(ADR 0038):loader 只**预取**、不返回任何数据,
  // 组件按选中的组合 id 从缓存读(本文件已无 `useLoaderData`)。
  //
  // #488 票 3:只等「默认组合 id」(预取 key 必须对上),其余发出即返回。谁先回来谁先画,
  // 壳立刻出现;hero 与列表各有自己的边界,不再整页干等最慢的那个。
  loader: async ({ context: { queryClient } }) => {
    const { defaultId } = await queryClient.ensureQueryData(portfolioListQuery());
    queryClient.ensureQueryData(homeTabStripQuery(defaultId));
    queryClient.ensureQueryData(portfolioOverviewQuery(defaultId));
    queryClient.ensureQueryData(portfolioGain24hQuery(defaultId));
    queryClient.ensureQueryData(portfolioHistoryQuery(defaultId));
  },
  component: Overview,
});

import { createFileRoute } from "@tanstack/react-router";
import { pickSelectedPortfolio } from "@/lib/hooks/use-portfolio";
import { portfolioListQuery } from "@/lib/queries/portfolio";
import { prefetchOverview } from "@/lib/queries/prefetch-pages";
import { Overview } from "./-home";

export const Route = createFileRoute("/_authed/")({
  // 主 tab(`tab`)与代币抽屉(`token`)不再进 URL(FOL-80,反转 ADR 0043):它们住组件内部 state
  // (`-home/view-state.tsx`),由 `<Activity>` 保活跨切换留存。本路由自身因此没有 search 参数 ——
  // `?portfolio` 是父层 `_authed` 的,`loaderDeps` 仍从合并后的 search 里读它。
  //
  // 预取的 key 跟着**地址里的组合**走(ADR 0046)。以前写死 `defaultId` 恰好是对的 —— 那时选中态
  // 总是从默认开始;URL 能说别的之后不改这里,就是「不改也没人报 bug、只是静默慢一拍」的那种错:
  // 硬加载一个非默认地址先预取默认那份,组件再各自重拉一遍。
  //
  // 参数进 `loaderDeps` 才算真的依赖它:框架模型是 URL → loader → 数据,只读地址而不声明依赖,
  // 得到的是一个「按它没声明依赖的地址准备数据」的 loader(切组合后不重跑)。
  loaderDeps: ({ search }) => ({ portfolio: search.portfolio }),
  // 本页的读取**已全部迁到 react-query**(ADR 0038):loader 只**预取**、不返回任何数据,
  // 组件按选中的组合 id 从缓存读(本文件已无 `useLoaderData`)。
  //
  // #488 票 3:只等「是哪个组合」(预取 key 必须对上),其余发出即返回。谁先回来谁先画,
  // 壳立刻出现;hero 与列表各有自己的边界,不再整页干等最慢的那个。
  loader: async ({ context: { queryClient }, deps }) => {
    const { portfolios, defaultId } = await queryClient.ensureQueryData(portfolioListQuery());
    const selectedId = pickSelectedPortfolio(deps.portfolio, portfolios, defaultId);
    prefetchOverview(queryClient, selectedId);
  },
  component: Overview,
});

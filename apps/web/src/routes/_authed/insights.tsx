import { createFileRoute } from "@tanstack/react-router";
import { pickSelectedPortfolio } from "@/lib/hooks/use-portfolio";
import { portfolioListQuery } from "@/lib/queries/portfolio";
import { prefetchInsights } from "@/lib/queries/prefetch-pages";
import { Insights } from "./-insights";

export const Route = createFileRoute("/_authed/insights")({
  // 分布维度(`dim`)不再进 URL(FOL-80,反转 ADR 0043):住 AllocationCard 内部 state。本路由自身
  // 没有 search 参数;`?portfolio` 是父层 `_authed` 的,`loaderDeps` 仍从合并后的 search 里读它。
  //
  // 预取的 key 跟着地址里的组合走(ADR 0046,理由见首页那条);参数进 `loaderDeps` 才算真的依赖它。
  loaderDeps: ({ search }) => ({ portfolio: search.portfolio }),
  // 与首页同款:loader 只等「是哪个组合」(预取 key 必须对上),原子快照与历史发出即返回。
  loader: async ({ context: { queryClient }, deps }) => {
    const { portfolios, defaultId } = await queryClient.ensureQueryData(portfolioListQuery());
    const selectedId = pickSelectedPortfolio(deps.portfolio, portfolios, defaultId);
    prefetchInsights(queryClient, selectedId);
  },
  component: Insights,
});

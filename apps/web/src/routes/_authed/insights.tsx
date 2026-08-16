import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { z } from "zod";
import {
  portfolioHistoryQuery,
  portfolioListQuery,
  portfolioOverviewQuery,
} from "../../lib/queries/portfolio";
import { Insights } from "./-insights";
import { ALLOC_DIMENSION, DEFAULT_DIM } from "./-insights/allocation";

export const Route = createFileRoute("/_authed/insights")({
  // 分布维度进 URL(ADR 0043):刷新还停在原维度、链接能分享。
  //
  // 校验器就是维度那份 zod schema 本身(`-insights/allocation.ts`)。`.catch(DEFAULT_DIM)`
  // 把认不出的值和没带的参数一并收成默认维度。
  //
  // 这里必须显式产出 `dim`,不能对非法值返回 `{}`:router 把验证结果合并进已有 search,
  // 没被覆盖的键原样留着,`?dim=bogus` 就会漏进组件。
  validateSearch: z.object({ dim: ALLOC_DIMENSION.catch(DEFAULT_DIM) }),
  search: { middlewares: [stripSearchParams({ dim: DEFAULT_DIM })] },
  // 与首页同款:loader 只等默认组合 id(预取 key 必须对上),总览和历史发出即返回。
  loader: async ({ context: { queryClient } }) => {
    const { defaultId } = await queryClient.ensureQueryData(portfolioListQuery());
    queryClient.ensureQueryData(portfolioOverviewQuery(defaultId));
    queryClient.ensureQueryData(portfolioHistoryQuery(defaultId));
  },
  component: Insights,
});

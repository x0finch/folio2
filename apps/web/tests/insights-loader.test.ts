import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #495 票 1:洞察 loader 只等默认组合 id,总览和历史发出即返回。
// 谁把它们重新 await 回去,硬刷新的白屏就回来,而且没有任何运行时报错。

const ROOT = join(import.meta.dirname, "../src");

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("洞察 loader 不再等待慢查询", () => {
  it("发出总览和历史,但不 await", () => {
    const route = stripComments(src("routes/_authed/insights.tsx"));
    expect(route).toContain("portfolioOverviewQuery(");
    expect(route).toContain("portfolioHistoryQuery(");
    expect(route).not.toMatch(/await Promise\.all\([\s\S]*portfolioOverviewQuery/);
    expect(route).not.toMatch(/await queryClient\.ensureQueryData\(portfolioOverviewQuery/);
    expect(route).not.toMatch(/await queryClient\.ensureQueryData\(portfolioHistoryQuery/);
  });

  it("路由没有 pendingComponent", () => {
    expect(stripComments(src("routes/_authed/insights.tsx"))).not.toContain("pendingComponent");
  });
});

describe("洞察两图各自加载", () => {
  it("走势和分布都用非挂起查询,没数据(含失败)走骨架", () => {
    const page = stripComments(src("routes/_authed/-insights/index.tsx"));
    expect(page).toContain("useQuery");
    expect(page).not.toContain("useSuspenseQuery");
    expect(page).toContain("historyQuery.data == null");
    expect(page).toContain("overviewQuery.data == null");
    expect(page).toContain("retry: true");
  });

  it("图框骨架与真图同高", () => {
    expect(src("routes/_authed/-insights/portfolio-chart.tsx")).toContain("CHART_FRAME");
    expect(src("routes/_authed/-insights/index.tsx")).toContain("CHART_FRAME");
  });

  it("维度 tab 在饼图查询之外,没数也能点", () => {
    const page = stripComments(src("routes/_authed/-insights/index.tsx"));
    expect(page).toMatch(/<Tabs[\s\S]*\{pie\}/);
    expect(page).toContain("overviewQuery.data == null");
  });
});

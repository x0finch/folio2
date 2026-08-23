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
  // **两图各自一个边界**,一个慢不拖另一个 —— 这是这一组的本意。
  //
  // 机制换过一次:原来是 `useQuery` + `data == null` 判骨架,现在是挂起 + `QueryBoundary`。
  // 换的理由是 SSR:服务端渲染那一遍这两条往往已经回来了,而客户端补水那一帧没有 ——
  // 一边画图一边画骨架,React 把整棵子树丢掉重渲。挂起让两边挂在同一个点上。
  // **要钉的性质没变**:各自加载、没数据(含失败)都走同高的骨架、这一页不出失败句。
  it("走势和分布各自一个边界,没数据(含失败)走骨架", () => {
    const page = stripComments(src("routes/_authed/-insights/index.tsx"));
    expect(page.match(/<QueryBoundary/g)).toHaveLength(2);
    // 两个边界的 pending 与 failed 都是那个骨架:这一页不显示失败句(#495)。
    expect(page.match(/pending=\{<Skeleton className=\{CHART_FRAME\} \/>\}/g)).toHaveLength(2);
    expect(page.match(/failed=\{<Skeleton className=\{CHART_FRAME\} \/>\}/g)).toHaveLength(2);
    expect(page).toContain("retry: true");
  });

  it("图框骨架与真图同高", () => {
    expect(src("routes/_authed/-insights/portfolio-chart.tsx")).toContain("CHART_FRAME");
    expect(src("routes/_authed/-insights/index.tsx")).toContain("CHART_FRAME");
  });

  it("维度 tab 在饼图那个边界之外,没数也能点", () => {
    const page = stripComments(src("routes/_authed/-insights/index.tsx"));
    // tab 先渲、饼图那块在后面 —— 挂起点在 `AllocationReady` 里,挂不住 tab。
    expect(page).toMatch(/<Tabs[\s\S]*\{pie\}/);
    expect(page).toMatch(/pie = \([\s\S]*<AllocationReady/);
  });
});

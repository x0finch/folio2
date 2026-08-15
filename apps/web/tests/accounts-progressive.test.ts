import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #493 票 2:名单先出、金额后到。骨架跟真内容漂了,没有运行时报错,
// 只有「数字出来的时候整页顿一下」或「回访先闪骨架」。

const ROOT = join(import.meta.dirname, "../src");

function src(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("骨架与真内容同形", () => {
  it("名单骨架贴合真实行的 padding", () => {
    const page = src("routes/_authed/-accounts/index.tsx");
    expect(page).toContain("px-3 py-3");
    expect(page).toMatch(/function ListSkeleton[\s\S]*px-3 py-3/);
  });

  it("金额没到时走骨架,不是 0,也不是破折号", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toContain("!row.valuesReady");
    expect(page).not.toMatch(/valuesReady[\s\S]{0,80}usd\(0\)/);
  });
});

describe("回访不闪骨架、金额失败继续骨架", () => {
  it("持仓加载态看 data / isPending,不看 isFetching —— 缓存命中后台刷新不该再出骨架", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toContain("holdingsQuery");
    expect(page).not.toContain("holdingsQuery.isFetching");
  });

  it("名单等归属到了再画,避免先画出别的组合的账户", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toMatch(/useSuspenseQuery\(accountListQuery/);
    expect(page).toMatch(/useSuspenseQuery\(portfolioMembershipsQuery/);
  });

  it("标签走 useQuery,不挡名单的 suspense", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toMatch(/useQuery\(tagListQuery/);
    expect(page).toMatch(/useQuery\(accountTagLinksQuery/);
    expect(page).not.toMatch(/useSuspenseQuery\(tagListQuery/);
    expect(page).not.toMatch(/useSuspenseQuery\(accountTagLinksQuery/);
  });

  it("持仓走 useQuery,失败不写拉取失败", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toMatch(/useQuery\(accountHoldingsQuery/);
    expect(page).not.toMatch(/useSuspenseQuery\(accountHoldingsQuery/);
    expect(page).not.toMatch(/holdingsQuery\.isError[\s\S]{0,80}loadFailed/);
  });

  it("盈亏加载态看 isPending,不看 isFetching —— 缓存命中后台刷新不该再出骨架", () => {
    const page = stripComments(src("routes/_authed/-accounts/index.tsx"));
    expect(page).toContain("gainQuery.isPending");
    expect(page).not.toContain("gainQuery.isFetching");
  });

  it("没有自造 hydration 开关来躲骨架", () => {
    const page = src("routes/_authed/-accounts/index.tsx");
    expect(page).not.toMatch(/useHydrated|use-hydrated|isHydrated/);
  });
});

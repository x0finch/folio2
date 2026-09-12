import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #488 票 3:首页 loader 只等「默认组合 id」(预取 key 必须对上),其余查询发出即返回。
// FOL-56:总览改原子 query,不再预取 `portfolioOverviewQuery`。
//
// FOL-81 把四个 page 合成一条 `{-$page}` 路由,这些性质因此分住两处:**取什么**搬进了
// `lib/queries/prefetch-pages.ts` 的 `prefetchOverview`(一份两用,路由 loader 与导航项
// pointerdown 预热共用同一个函数),**等什么**留在合并路由的 loader 里(只等「是哪个组合」)。
// 要钉的东西一条没变,只是各自钉在新家上。

const PREFETCH = join(import.meta.dirname, "../src/lib/queries/prefetch-pages.ts");
// 文件名里那对花括号是真的(可选路径参数 `{-$page}`),不是模板占位。
const ROUTE = join(import.meta.dirname, "../src/routes/_authed/{-$page}.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// 只取某一个 prefetch 函数的身体:四页的预取同住一个文件,不切出来的话「总览不取 X」
// 会被隔壁那页取 X 的那行冒充成绿的。找不到就抛 —— 切空了的话下面每条 `not.toContain` 都是空断言。
function prefetchBody(name: string): string {
  const src = stripComments(readFileSync(PREFETCH, "utf8"));
  const start = src.indexOf(`export function ${name}`);
  if (start < 0) throw new Error(`prefetch-pages.ts 里没有 ${name}`);
  const next = src.indexOf("export function", start + 1);
  return next < 0 ? src.slice(start) : src.slice(start, next);
}

describe("首页 loader 不再等待慢查询", () => {
  it("发出原子快照与走势,但不 await 它们", () => {
    const src = prefetchBody("prefetchOverview");
    expect(src).toContain("accountHoldingsSnapshotQueries(");
    expect(src).toContain("portfolioHistoryQuery(");
    expect(src).not.toMatch(/await Promise\.all\([\s\S]*accountHoldingsSnapshotQueries/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(portfolioHistoryQuery/);
    expect(src).not.toContain("portfolioOverviewQuery");
    expect(src).not.toContain("getPortfolioSnapshotData");
  });

  it("发出 tabPins 与标签,但不 await", () => {
    const src = prefetchBody("prefetchOverview");
    expect(src).toContain("portfolioTabPinsQuery(");
    expect(src).toContain("tagListQuery(");
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(portfolioTabPinsQuery/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(tagListQuery/);
  });

  it("不再单独预取 24h 盈亏(它随快照原料在浏览器算)", () => {
    expect(prefetchBody("prefetchOverview")).not.toContain("portfolioGain24hQuery");
  });

  it("首页从总览读 24h 盈亏(FOL-51:随原料两端相减算好)", () => {
    const hero = stripComments(
      readFileSync(join(import.meta.dirname, "../src/routes/_authed/-home/hero/index.tsx"), "utf8"),
    );
    expect(hero).toMatch(/overview\.gain24h/);
    expect(hero).toMatch(/usePortfolioOverview\(/);
    expect(hero).not.toContain("portfolioGain24hQuery");
    expect(hero).not.toContain("portfolioOverviewQuery");
    expect(hero).not.toContain("getPortfolioSnapshotData");
  });

  it("连接器目录、账户清单进 loader(原子资源);标签与 tabPins 发出但不 await", () => {
    const src = prefetchBody("prefetchOverview");
    expect(src).toContain("connectorCatalogQuery");
    expect(src).toContain("accountListQuery");
    expect(src).toContain("tagListQuery");
    expect(src).toContain("portfolioTabPinsQuery");
    expect(src).not.toContain("portfolioOverviewQuery");
  });
});

describe("合并路由只等「是哪个组合」", () => {
  // 「其余发出即返回」的另一半:prefetch 函数体里一个 await 都没有,是因为路由压根不等它们。
  // 谁把某一页的预取 await 回去,硬刷新的白屏就回来,而且没有任何运行时报错。
  it("loader 里唯一的 await 是 portfolioListQuery", () => {
    const route = stripComments(readFileSync(ROUTE, "utf8"));
    const awaits = route.match(/await [^\n]*/g) ?? [];
    expect(awaits).toHaveLength(1);
    expect(awaits[0]).toContain("portfolioListQuery()");
  });
});

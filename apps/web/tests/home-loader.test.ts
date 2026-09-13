import { describe, expect, it } from "vitest";
import { prefetchBody, readSrc, stripComments } from "./helpers/prefetch-source";

// 文件名里那对花括号是真的(可选路径参数 `{-$page}`),不是模板占位。
const ROUTE = "routes/_authed/{-$page}.tsx";

// #488 票 3:首页 loader 只等「默认组合 id」(预取 key 必须对上),其余查询发出即返回。
// FOL-56:总览改原子 query,不再预取 `portfolioOverviewQuery`。
//
// FOL-81 把四个 page 合成一条 `{-$page}` 路由,这些性质因此分住两处:**取什么**搬进了
// `lib/queries/prefetch-pages.ts` 的 `prefetchOverview`(一份两用,路由 loader 与导航项
// pointerdown 预热共用同一个函数),**等什么**留在合并路由的 loader 里(只等「是哪个组合」)。
// 要钉的东西一条没变,只是各自钉在新家上。

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
    const hero = stripComments(readSrc("routes/_authed/-home/hero/index.tsx"));
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
  //
  // loader 里允许等的只有两样:「是哪个组合」(预取 key 必须对上)和**外壳同步摘要的两条原料**。
  // 后者是必须等的:外壳用 `useSuspenseQueries` 读它们、上面没有自己的边界,切到没看过的组合时不等,
  // 外壳就整个退成骨架壳再重挂(页头药丸 / 弹层重建、动画互撞)。冷加载不因此变慢 —— `_authed`
  // 的 loader 本来就等同一份(ensureQueryData 同 key 去重)。
  it("loader 只 await 两样:portfolioListQuery 与外壳的同步摘要原料", () => {
    const route = stripComments(readSrc(ROUTE));
    const awaits = route.match(/await [^\n]*/g) ?? [];
    expect(awaits).toHaveLength(2);
    expect(awaits[0]).toContain("portfolioListQuery()");
    expect(awaits[1]).toContain("prefetchSyncStatusAtoms(queryClient, selectedId)");
  });
});

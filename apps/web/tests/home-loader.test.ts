import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #488 票 3:首页 loader 只等「默认组合 id」(预取 key 必须对上),其余查询发出即返回。
// FOL-56:总览改原子 query,不再预取 `portfolioOverviewQuery`。

const SRC = join(import.meta.dirname, "../src/routes/_authed/index.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("首页 loader 不再等待慢查询", () => {
  it("发出原子快照与走势,但不 await 它们", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).toContain("accountHoldingsSnapshotQueries(");
    expect(src).toContain("portfolioHistoryQuery(");
    expect(src).not.toMatch(/await Promise\.all\([\s\S]*accountHoldingsSnapshotQueries/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(portfolioHistoryQuery/);
    expect(src).not.toContain("portfolioOverviewQuery");
    expect(src).not.toContain("getPortfolioSnapshotData");
  });

  it("发出 tabPins 与标签,但不 await", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).toContain("portfolioTabPinsQuery(");
    expect(src).toContain("tagListQuery(");
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(portfolioTabPinsQuery/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(tagListQuery/);
  });

  it("不再单独预取 24h 盈亏(它随快照原料在浏览器算)", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).not.toContain("portfolioGain24hQuery");
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
    const src = stripComments(readFileSync(SRC, "utf8"));
    const loader = src.slice(src.indexOf("loader:"), src.indexOf("component:"));
    expect(loader).toContain("connectorCatalogQuery");
    expect(loader).toContain("accountListQuery");
    expect(loader).toContain("tagListQuery");
    expect(loader).toContain("portfolioTabPinsQuery");
    expect(loader).not.toContain("portfolioOverviewQuery");
  });
});

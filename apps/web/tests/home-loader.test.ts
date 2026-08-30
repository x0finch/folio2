import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #488 票 3:首页 loader 只等「默认组合 id」(预取 key 必须对上),其余查询发出即返回。
// 谁把总览或走势重新 await 回去,硬刷新的白屏就回来,而且没有任何运行时报错。

const SRC = join(import.meta.dirname, "../src/routes/_authed/index.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("首页 loader 不再等待慢查询", () => {
  it("发出总览和走势,但不 await 它们", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).toContain("portfolioOverviewQuery(");
    expect(src).toContain("portfolioHistoryQuery(");
    expect(src).not.toMatch(/await Promise\.all\([\s\S]*portfolioOverviewQuery/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(portfolioOverviewQuery/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(portfolioHistoryQuery/);
  });

  // tab 条:pin 轻请求 + 标签(发出不等);永续/DeFi 从 overview 缓存借。
  it("发出 tabPins 与标签,但不 await", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).toContain("portfolioTabPinsQuery(");
    expect(src).toContain("tagListQuery(");
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(portfolioTabPinsQuery/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(tagListQuery/);
  });

  // FOL-51:24h 盈亏改成随总览原料(两端相减、浏览器算)一起回,不再有独立的盈亏预取。
  it("不再单独预取 24h 盈亏(它随总览原料一起回)", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).not.toContain("portfolioGain24hQuery");
  });

  it("首页从总览读 24h 盈亏(FOL-51:随原料两端相减算好)", () => {
    const hero = stripComments(
      readFileSync(join(import.meta.dirname, "../src/routes/_authed/-home/hero/index.tsx"), "utf8"),
    );
    expect(hero).toMatch(/overview\.gain24h/);
    expect(hero).not.toContain("portfolioGain24hQuery");
  });

  it("连接器目录、账户清单不进 loader;标签与 tabPins 发出但不 await", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    const loader = src.slice(src.indexOf("loader:"), src.indexOf("component:"));
    expect(loader).not.toContain("connectorCatalogQuery");
    expect(loader).not.toContain("accountListQuery");
    expect(loader).toContain("tagListQuery");
    expect(loader).toContain("portfolioTabPinsQuery");
  });
});

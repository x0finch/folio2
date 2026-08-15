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

  // #488 票 4:tab 条有自己的轻请求。发出不等;目录 / 账户 / 标签不再走首屏。
  it("发出 tab 条轻请求,但不 await", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).toContain("homeTabStripQuery(");
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(homeTabStripQuery/);
  });

  it("发出 24h 盈亏,但不 await", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).toContain("portfolioGain24hQuery(");
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(portfolioGain24hQuery/);
  });

  it("首页不从总览读 24h 盈亏", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).not.toMatch(/data\.gain24h/);
    const hero = stripComments(
      readFileSync(join(import.meta.dirname, "../src/routes/_authed/-home/hero/index.tsx"), "utf8"),
    );
    expect(hero).not.toMatch(/data\.gain24h/);
  });

  it("连接器目录、账户清单、标签清单、裸 pin 清单不进 loader", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    const loader = src.slice(src.indexOf("loader:"), src.indexOf("component:"));
    expect(loader).not.toContain("connectorCatalogQuery");
    expect(loader).not.toContain("accountListQuery");
    expect(loader).not.toContain("tagListQuery");
    expect(loader).not.toContain("tabPinsQuery");
  });
});

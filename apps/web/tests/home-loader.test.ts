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
});

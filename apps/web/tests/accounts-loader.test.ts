import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #493 票 2:账户页 loader 发出持仓但不 await。谁把持仓重新 await 回去,
// 硬刷新的白屏就回来,而且没有任何运行时报错。

const SRC = join(import.meta.dirname, "../src/routes/_authed/accounts.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("账户页 loader 不再等待慢查询", () => {
  it("发出持仓,但不 await", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).toContain("accountHoldingsQuery(");
    expect(src).not.toMatch(/await Promise\.all\([\s\S]*accountHoldingsQuery/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(accountHoldingsQuery/);
  });

  it("发出标签,但不 await —— 标签不挡名单", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).toContain("tagListQuery(");
    expect(src).toContain("accountTagLinksQuery(");
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(tagListQuery/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(accountTagLinksQuery/);
  });

  it("发出 24h 盈亏,但不 await", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).toContain("accountGain24hQuery(");
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(accountGain24hQuery/);
  });

  it("路由没有 pendingComponent,冷启动骨架是页上那套,不是另一张整页骨架", () => {
    const src = stripComments(readFileSync(SRC, "utf8"));
    expect(src).not.toContain("pendingComponent");
  });
});

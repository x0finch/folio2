import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #493 票 2:账户页 loader 发出持仓但不 await。谁把持仓重新 await 回去,
// 硬刷新的白屏就回来,而且没有任何运行时报错。
//
// FOL-81 后这份 loader 身体搬进了 `lib/queries/prefetch-pages.ts` 的 `prefetchAccounts`
// (四页合成一条 `{-$page}` 路由,预取一份两用:loader 与导航 pointerdown 预热共用),
// 「没有 pendingComponent」则钉在那条合并路由上。

const PREFETCH = join(import.meta.dirname, "../src/lib/queries/prefetch-pages.ts");
// 文件名里那对花括号是真的(可选路径参数 `{-$page}`),不是模板占位。
const ROUTE = join(import.meta.dirname, "../src/routes/_authed/{-$page}.tsx");

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

// 只取账户页那一段:四页的预取同住一个文件,不切出来的话「账户页不取 X」会被隔壁那页
// 取 X 的那行冒充成绿的。找不到就抛 —— 切空了的话下面每条 `not.toContain` 都是空断言。
function prefetchBody(name: string): string {
  const src = stripComments(readFileSync(PREFETCH, "utf8"));
  const start = src.indexOf(`export function ${name}`);
  if (start < 0) throw new Error(`prefetch-pages.ts 里没有 ${name}`);
  const next = src.indexOf("export function", start + 1);
  return next < 0 ? src.slice(start) : src.slice(start, next);
}

describe("账户页 loader 不再等待慢查询", () => {
  it("发出原子持仓资源,但不 await", () => {
    const src = prefetchBody("prefetchAccounts");
    expect(src).toContain("accountHoldingsSnapshotQueries(");
    expect(src).toContain("tokenEnrichmentQuery(");
    expect(src).not.toMatch(/await Promise\.all\([\s\S]*accountHoldingsSnapshotQueries/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(accountHoldingsSnapshotQueries/);
    expect(src).not.toContain("accountHoldingsQuery(");
    expect(src).not.toContain("listAccountHoldings");
  });

  it("发出标签,但不 await —— 标签不挡名单", () => {
    const src = prefetchBody("prefetchAccounts");
    expect(src).toContain("tagListQuery(");
    expect(src).toContain("accountTagLinksQuery(");
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(tagListQuery/);
    expect(src).not.toMatch(/await queryClient\.ensureQueryData\(accountTagLinksQuery/);
  });

  // FOL-51:24h 盈亏改成随持仓(`accountHoldingsQuery`,两端相减服务端现算)一起回,不再单独预取。
  it("不再单独预取 24h 盈亏(它随持仓一起回)", () => {
    expect(prefetchBody("prefetchAccounts")).not.toContain("accountGain24hQuery");
  });

  it("路由没有 pendingComponent,冷启动骨架是页上那套,不是另一张整页骨架", () => {
    const src = stripComments(readFileSync(ROUTE, "utf8"));
    expect(src).not.toContain("pendingComponent");
  });
});

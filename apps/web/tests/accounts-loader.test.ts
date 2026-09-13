import { describe, expect, it } from "vitest";
import { prefetchBody, readSrc, stripComments } from "./helpers/prefetch-source";

// 文件名里那对花括号是真的(可选路径参数 `{-$page}`),不是模板占位。
const ROUTE = "routes/_authed/{-$page}.tsx";

// #493 票 2:账户页 loader 发出持仓但不 await。谁把持仓重新 await 回去,
// 硬刷新的白屏就回来,而且没有任何运行时报错。
//
// FOL-81 后这份 loader 身体搬进了 `lib/queries/prefetch-pages.ts` 的 `prefetchAccounts`
// (四页合成一条 `{-$page}` 路由,预取一份两用:loader 与导航 pointerdown 预热共用),
// 「没有 pendingComponent」则钉在那条合并路由上。

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
    const src = stripComments(readSrc(ROUTE));
    expect(src).not.toContain("pendingComponent");
  });
});

import { describe, expect, it } from "vitest";
import { prefetchBody } from "./helpers/prefetch-source";

// #493 票 2:账户页 loader 发出持仓但不 await。谁把持仓重新 await 回去,
// 硬刷新的白屏就回来,而且没有任何运行时报错。
//
// FOL-81 后这份 loader 身体搬进了 `lib/queries/prefetch-pages.ts` 的 `prefetchAccounts`
// (四页合成一条 `{-$page}` 路由,预取一份两用:loader 与导航 pointerdown 预热共用);
// 「那条合并路由没有 pendingComponent」钉在 home-progressive.test.ts。

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
});

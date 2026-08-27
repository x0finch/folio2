import { Database } from "@folio/db";
import { Effect } from "effect";
import { type PortfolioScope, scopedMembership } from "@/lib/server/portfolio/scope";

// 账户→Tag 关联。**只回当前组合的账户那些**(ADR 0047):展示富化仍在客户端按 accountId 组装,
// 但组装的原料不再包含别的组合。判据与账户列表同一个(归档无关 —— 归档行也要显示标签)。
export const handleListAccountTags = Effect.fn("listAccountTags")(function* (
  data: PortfolioScope = {},
) {
  const [scope, links] = yield* Effect.all(
    [scopedMembership(data.portfolioId), (yield* Database).tags.listAccountLinks()],
    { concurrency: 2 },
  );
  return links.filter((l) => scope.has(l.accountId));
});

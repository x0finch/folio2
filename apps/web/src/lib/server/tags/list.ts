import { Database } from "@folio/db";
import { Effect } from "effect";
import { type PortfolioScope, resolveScope } from "@/lib/server/portfolio/scope";

// Tag 定义。**只回当前组合那些**(ADR 0047):Tag 本来就归属 Portfolio(ADR 0034),
// 以前整份下发、用的那几处各自筛一遍 —— 别的组合的标签名因此都在响应里。
export const handleListTags = Effect.fn("listTags")(function* (data: PortfolioScope = {}) {
  const { selectedId } = yield* resolveScope(data.portfolioId);
  return yield* (yield* Database).tags.listByPortfolio(selectedId);
});

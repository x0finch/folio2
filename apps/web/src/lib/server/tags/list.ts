import { Database } from "@folio/db";
import { Effect } from "effect";
import { type PortfolioScope, resolveScope } from "@/lib/server/portfolio/scope";

export const handleListTags = Effect.fn("listTags")(function* (data: PortfolioScope = {}) {
  const { selectedId } = yield* resolveScope(data.portfolioId);
  return yield* (yield* Database).tags.listByPortfolio(selectedId);
});

import { Database } from "@folio/db";
import { type PortfolioScope, resolveScope } from "@/lib/server/portfolio/scope";
import { serverFn } from "@/lib/server/server-fn";

export const handleListTags = serverFn("listTags")(function* (data: PortfolioScope = {}) {
  const { selectedId } = yield* resolveScope(data.portfolioId);
  return yield* (yield* Database).tags.listByPortfolio(selectedId);
});

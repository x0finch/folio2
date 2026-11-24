import { Database } from "@folio/db";
import { Effect } from "effect";
import { type PortfolioScope, scopedMembership } from "@/lib/server/portfolio/scope";

// Scoped to the current portfolio's accounts, archived included (they show tags too).
export const handleListAccountTags = Effect.fn("listAccountTags")(function* (
  data: PortfolioScope = {},
) {
  const [scope, links] = yield* Effect.all(
    [scopedMembership(data.portfolioId), (yield* Database).tags.listAccountLinks()],
    { concurrency: 2 },
  );
  return links.filter((l) => scope.has(l.accountId));
});

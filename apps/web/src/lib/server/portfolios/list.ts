import { Database } from "@folio/db";
import { Effect } from "effect";

// List first and ensureDefault only if the default row is missing: one query after first visit.
// Never run both concurrently, or list can win and return a defaultId absent from the list.
export const handleListPortfolios = Effect.fn("listPortfolios")(function* () {
  const store = (yield* Database).portfolios;
  let portfolios = yield* store.list();
  let defaultPf = portfolios.find((p) => p.isDefault);
  if (!defaultPf) {
    defaultPf = yield* store.ensureDefault();
    portfolios = yield* store.list();
  }
  return {
    portfolios: portfolios.map((p) => ({ id: p.id, name: p.name, isDefault: p.isDefault })),
    defaultId: defaultPf.id,
  };
});

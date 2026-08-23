import { Effect } from "effect";
import { buildScopedOverview, type PortfolioScope } from "./scope";

export const handleGetPortfolioOverview = Effect.fn("getPortfolioOverview")(function* (
  data: PortfolioScope,
) {
  return yield* buildScopedOverview(data, false);
});

import { manualFiatRefs } from "@/lib/server/manual/store";
import { serverFn } from "@/lib/server/server-fn";
import { type PortfolioScope, scopedMembership } from "./scope";

// tokenId -> `fiat/issued:<CODE>` for the portfolio's active manual accounts, fed to `buildOverview` as `fiatRefs`.

export const handleGetFiatRefs = serverFn("getFiatRefs")(function* (data: PortfolioScope = {}) {
  const member = yield* scopedMembership(data.portfolioId);
  const accounts = member.accounts.filter((a) => member.has(a.id));
  const fiatRefs = yield* manualFiatRefs(accounts);
  return { fiatRefs: [...fiatRefs] as [string, string][] };
});

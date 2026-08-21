import { runAtEdge, withRequest } from "../oracle";
import type { AuthContext } from "../session/auth-session";
import { buildScopedOverview, type PortfolioScope } from "./scope";

export function handleGetPortfolioOverview({
  data,
  context,
}: {
  data: PortfolioScope;
  context: AuthContext;
}) {
  return runAtEdge(withRequest(context.userId, buildScopedOverview(data, false)));
}

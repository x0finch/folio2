import { runAtEdge, withRequest } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";
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

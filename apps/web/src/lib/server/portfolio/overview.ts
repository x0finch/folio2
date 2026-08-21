import { runAtEdge, withRequest } from "../oracle";
import { buildScopedOverview, type PortfolioScope } from "./scope";

export function handleGetPortfolioOverview({
  data,
  context,
}: {
  data: PortfolioScope;
  context: { userId: string };
}) {
  return runAtEdge(withRequest(context.userId, buildScopedOverview(data, false)));
}

import { PortfolioStore } from "@folio/db";
import { runStore } from "../oracle";

// 改名(含默认)。
export async function handleRenamePortfolio({
  data,
  context,
}: {
  data: { portfolioId: string; name: string };
  context: { userId: string };
}) {
  await runStore(context.userId, PortfolioStore, (s) => s.rename(data.portfolioId, data.name));
  return { ok: true as const };
}

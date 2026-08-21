import { PortfolioStore } from "@folio/db";
import { runStore } from "../oracle";

// 删除(默认不可删):成员退回默认后删该行。
export async function handleDeletePortfolio({
  data,
  context,
}: {
  data: { portfolioId: string };
  context: { userId: string };
}) {
  await runStore(context.userId, PortfolioStore, (s) => s.remove(data.portfolioId));
  return { ok: true as const };
}

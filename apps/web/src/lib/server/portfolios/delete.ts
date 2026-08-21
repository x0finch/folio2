import { PortfolioStore } from "@folio/db";
import { z } from "zod";
import { runStore } from "../oracle";

// 删除(默认不可删):成员退回默认后删该行。
export const DeletePortfolioInput = z.object({ portfolioId: z.string().min(1) });

export async function handleDeletePortfolio({
  data,
  context,
}: {
  data: z.infer<typeof DeletePortfolioInput>;
  context: { userId: string };
}) {
  await runStore(context.userId, PortfolioStore, (s) => s.remove(data.portfolioId));
  return { ok: true as const };
}

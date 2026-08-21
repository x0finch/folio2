import { PortfolioStore } from "@folio/db";
import { z } from "zod";
import { runStore } from "../oracle";
import type { AuthContext } from "../session/auth-session";

// 改名(含默认)。
export const RenamePortfolioInput = z.object({
  portfolioId: z.string().min(1),
  name: z.string().trim().min(1),
});

export async function handleRenamePortfolio({
  data,
  context,
}: {
  data: z.infer<typeof RenamePortfolioInput>;
  context: AuthContext;
}) {
  await runStore(context.userId, PortfolioStore, (s) => s.rename(data.portfolioId, data.name));
  return { ok: true as const };
}

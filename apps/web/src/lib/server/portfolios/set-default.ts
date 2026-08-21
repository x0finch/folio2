import { PortfolioStore } from "@folio/db";
import { z } from "zod";
import { runStore } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";

// 设为默认(顶层净值 / 硬刷新的落点随之改)。
export const SetDefaultPortfolioInput = z.object({ portfolioId: z.string().min(1) });

export async function handleSetDefaultPortfolio({
  data,
  context,
}: {
  data: z.infer<typeof SetDefaultPortfolioInput>;
  context: AuthContext;
}) {
  await runStore(context.userId, PortfolioStore, (s) => s.setDefault(data.portfolioId));
  return { ok: true as const };
}

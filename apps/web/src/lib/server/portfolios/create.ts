import { PortfolioStore } from "@folio/db";
import { z } from "zod";
import { runStore } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";

// 新建命名 Portfolio(选择器/移到弹窗的「新建」页;只建、不归属 —— 建完回列表由用户再选,ADR 0033)。
export const CreatePortfolioInput = z.object({ name: z.string().trim().min(1) });

export async function handleCreatePortfolio({
  data,
  context,
}: {
  data: z.infer<typeof CreatePortfolioInput>;
  context: AuthContext;
}) {
  const pf = await runStore(context.userId, PortfolioStore, (s) => s.create({ name: data.name }));
  return { id: pf.id };
}

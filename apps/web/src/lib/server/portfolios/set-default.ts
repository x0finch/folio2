import { PortfolioStore } from "@folio/db";
import { runStore } from "../oracle";

// 设为默认(顶层净值 / 硬刷新的落点随之改)。
export async function handleSetDefaultPortfolio({
  data,
  context,
}: {
  data: { portfolioId: string };
  context: { userId: string };
}) {
  await runStore(context.userId, PortfolioStore, (s) => s.setDefault(data.portfolioId));
  return { ok: true as const };
}

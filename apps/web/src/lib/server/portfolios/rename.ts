import { Database } from "@folio/db";
import { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";

export const RenamePortfolioInput = z.object({
  portfolioId: z.string().min(1),
  name: z.string().trim().min(1),
});

export const handleRenamePortfolio = serverFn("renamePortfolio")(function* (
  data: z.infer<typeof RenamePortfolioInput>,
) {
  yield* (yield* Database).portfolios.rename(data.portfolioId, data.name);
  return { ok: true as const };
});

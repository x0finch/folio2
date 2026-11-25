import { Database } from "@folio/db";
import { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";

export const DeletePortfolioInput = z.object({ portfolioId: z.string().min(1) });

export const handleDeletePortfolio = serverFn("deletePortfolio")(function* (
  data: z.infer<typeof DeletePortfolioInput>,
) {
  yield* (yield* Database).portfolios.remove(data.portfolioId);
  return { ok: true as const };
});

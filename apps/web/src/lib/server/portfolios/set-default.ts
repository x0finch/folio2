import { Database } from "@folio/db";
import { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";

export const SetDefaultPortfolioInput = z.object({ portfolioId: z.string().min(1) });

export const handleSetDefaultPortfolio = serverFn("setDefaultPortfolio")(function* (
  data: z.infer<typeof SetDefaultPortfolioInput>,
) {
  yield* (yield* Database).portfolios.setDefault(data.portfolioId);
  return { ok: true as const };
});

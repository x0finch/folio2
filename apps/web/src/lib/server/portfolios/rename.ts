import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

// 改名(含默认)。
export const RenamePortfolioInput = z.object({
  portfolioId: z.string().min(1),
  name: z.string().trim().min(1),
});

export const handleRenamePortfolio = Effect.fn("renamePortfolio")(function* (
  data: z.infer<typeof RenamePortfolioInput>,
) {
  yield* (yield* Database).portfolios.rename(data.portfolioId, data.name);
  return { ok: true as const };
});

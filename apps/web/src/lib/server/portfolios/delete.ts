import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

// 删除(默认不可删):成员退回默认后删该行。
export const DeletePortfolioInput = z.object({ portfolioId: z.string().min(1) });

export const handleDeletePortfolio = Effect.fn("deletePortfolio")(function* (
  data: z.infer<typeof DeletePortfolioInput>,
) {
  yield* (yield* Database).portfolios.remove(data.portfolioId);
  return { ok: true as const };
});

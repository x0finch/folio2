import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";

// 删除(默认不可删):成员退回默认后删该行。
export const DeletePortfolioInput = z.object({ portfolioId: z.string().min(1) });

export const handleDeletePortfolio = Effect.fn("deletePortfolio")(function* (
  data: z.infer<typeof DeletePortfolioInput>,
) {
  yield* (yield* Database).portfolios.remove(data.portfolioId);
  // 组合的值变了 → 预计算的 24h 盈亏不再可信,就地标旧(ADR 0049;为什么标旧不是删,见那边)。
  yield* invalidatePrecomputed();
  return { ok: true as const };
});

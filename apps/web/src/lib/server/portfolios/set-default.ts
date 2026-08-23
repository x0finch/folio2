import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

// 设为默认(顶层净值 / 硬刷新的落点随之改)。
export const SetDefaultPortfolioInput = z.object({ portfolioId: z.string().min(1) });

export const handleSetDefaultPortfolio = Effect.fn("setDefaultPortfolio")(function* (
  data: z.infer<typeof SetDefaultPortfolioInput>,
) {
  yield* (yield* Database).portfolios.setDefault(data.portfolioId);
  return { ok: true as const };
});

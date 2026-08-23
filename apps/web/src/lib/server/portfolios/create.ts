import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

// 新建命名 Portfolio(选择器/移到弹窗的「新建」页;只建、不归属 —— 建完回列表由用户再选,ADR 0033)。
export const CreatePortfolioInput = z.object({ name: z.string().trim().min(1) });

export const handleCreatePortfolio = Effect.fn("createPortfolio")(function* (
  data: z.infer<typeof CreatePortfolioInput>,
) {
  const pf = yield* (yield* Database).portfolios.create({ name: data.name });
  return { id: pf.id };
});

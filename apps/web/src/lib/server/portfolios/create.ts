import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

export const CreatePortfolioInput = z.object({ name: z.string().trim().min(1) });

export const handleCreatePortfolio = Effect.fn("createPortfolio")(function* (
  data: z.infer<typeof CreatePortfolioInput>,
) {
  const pf = yield* (yield* Database).portfolios.create({ name: data.name });
  return { id: pf.id };
});

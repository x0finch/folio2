import { Database } from "@folio/db";
import { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";

export const CreatePortfolioInput = z.object({ name: z.string().trim().min(1) });

export const handleCreatePortfolio = serverFn("createPortfolio")(function* (
  data: z.infer<typeof CreatePortfolioInput>,
) {
  const pf = yield* (yield* Database).portfolios.create({ name: data.name });
  return { id: pf.id };
});

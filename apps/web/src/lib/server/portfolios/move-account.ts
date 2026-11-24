import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

// Exactly one of portfolioId / newName is required (enforced by the refine).
export const MoveAccountInput = z
  .object({
    accountId: z.string().min(1),
    portfolioId: z.string().min(1).optional(),
    newName: z.string().trim().min(1).optional(),
  })
  .refine((v) => v.portfolioId != null || v.newName != null, {
    message: "portfolioId or newName required",
  });

export const handleMoveAccountToPortfolio = Effect.fn("moveAccountToPortfolio")(function* (
  data: z.infer<typeof MoveAccountInput>,
) {
  const store = (yield* Database).portfolios;
  const targetId = data.newName
    ? (yield* store.create({ name: data.newName })).id
    : // biome-ignore lint/style/noNonNullAssertion: the refine above guarantees portfolioId or newName
      data.portfolioId!;
  yield* store.assignAccount(data.accountId, targetId);
  return { portfolioId: targetId };
});

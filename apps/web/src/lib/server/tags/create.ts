import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

export const CreateTagInput = z.object({
  portfolioId: z.string().min(1),
  name: z.string().trim().min(1, "tag name is required"),
});

export const handleCreateTag = Effect.fn("createTag")(function* (
  data: z.infer<typeof CreateTagInput>,
) {
  return yield* (yield* Database).tags.create({
    portfolioId: data.portfolioId,
    name: data.name,
  });
});

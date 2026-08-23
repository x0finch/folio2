import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

export const DeleteTagInput = z.object({ tagId: z.string().min(1) });

export const handleDeleteTag = Effect.fn("deleteTag")(function* (
  data: z.infer<typeof DeleteTagInput>,
) {
  return yield* (yield* Database).tags.remove(data.tagId);
});

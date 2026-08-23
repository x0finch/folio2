import { Database } from "@folio/db";
import { Effect } from "effect";
import type { z } from "zod";
import type { AccountTagInput } from "./attach";

export const handleDetachTag = Effect.fn("detachTag")(function* (
  data: z.infer<typeof AccountTagInput>,
) {
  return yield* (yield* Database).tags.detach(data.accountId, data.tagId);
});

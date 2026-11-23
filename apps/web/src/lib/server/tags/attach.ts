import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

// Shared with detach.
export const AccountTagInput = z.object({
  accountId: z.string().min(1),
  tagId: z.string().min(1),
});

export const handleAttachTag = Effect.fn("attachTag")(function* (
  data: z.infer<typeof AccountTagInput>,
) {
  const out = yield* (yield* Database).tags.attach(data.accountId, data.tagId);
  return out;
});

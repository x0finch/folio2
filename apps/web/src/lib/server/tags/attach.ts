import { Database } from "@folio/db";
import { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";

// Shared with detach.
export const AccountTagInput = z.object({
  accountId: z.string().min(1),
  tagId: z.string().min(1),
});

export const handleAttachTag = serverFn("attachTag")(function* (
  data: z.infer<typeof AccountTagInput>,
) {
  const out = yield* (yield* Database).tags.attach(data.accountId, data.tagId);
  return out;
});

import { Database } from "@folio/db";
import { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";

export const RenameTagInput = z.object({
  tagId: z.string().min(1),
  name: z.string().trim().min(1, "tag name is required"),
});

export const handleRenameTag = serverFn("renameTag")(function* (
  data: z.infer<typeof RenameTagInput>,
) {
  const out = yield* (yield* Database).tags.rename(data.tagId, data.name);
  return out;
});

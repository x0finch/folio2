import { Database } from "@folio/db";
import { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";

export const DeleteTagInput = z.object({ tagId: z.string().min(1) });

export const handleDeleteTag = serverFn("deleteTag")(function* (
  data: z.infer<typeof DeleteTagInput>,
) {
  const out = yield* (yield* Database).tags.remove(data.tagId);
  return out;
});

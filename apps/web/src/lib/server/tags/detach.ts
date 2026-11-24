import { Database } from "@folio/db";
import type { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";
import type { AccountTagInput } from "./attach";

export const handleDetachTag = serverFn("detachTag")(function* (
  data: z.infer<typeof AccountTagInput>,
) {
  const out = yield* (yield* Database).tags.detach(data.accountId, data.tagId);
  return out;
});

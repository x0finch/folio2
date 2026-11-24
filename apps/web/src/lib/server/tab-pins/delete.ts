import { Database } from "@folio/db";
import { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";

export const DeleteTabPinInput = z.object({ pinId: z.string().min(1) });

export const handleDeleteTabPin = serverFn("deleteTabPin")(function* (
  data: z.infer<typeof DeleteTabPinInput>,
) {
  const db = yield* Database;
  yield* db.tabPins.remove(data.pinId);
  return { ok: true as const };
});

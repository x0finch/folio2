import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";

export const DeleteTabPinInput = z.object({ pinId: z.string().min(1) });

export const handleDeleteTabPin = Effect.fn("deleteTabPin")(function* (
  data: z.infer<typeof DeleteTabPinInput>,
) {
  const db = yield* Database;
  yield* db.tabPins.remove(data.pinId);
  // 同 create:改的就是 tab 条那份数据本身(以及少掉的那一维)。
  yield* invalidatePrecomputed();
  return { ok: true as const };
});

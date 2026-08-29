import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { invalidateForPin } from "./create";

export const DeleteTabPinInput = z.object({ pinId: z.string().min(1) });

export const handleDeleteTabPin = Effect.fn("deleteTabPin")(function* (
  data: z.infer<typeof DeleteTabPinInput>,
) {
  const db = yield* Database;
  // **先读它指着谁,再删** —— 删完就问不出「这一格属于哪个组合」了,只能退回抬整个用户的。
  const gone = (yield* db.tabPins.list()).find((p) => p.id === data.pinId);
  yield* db.tabPins.remove(data.pinId);
  // 同 create:改的就是 tab 条那份数据本身(以及少掉的那一维)。
  yield* invalidateForPin(gone);
  return { ok: true as const };
});

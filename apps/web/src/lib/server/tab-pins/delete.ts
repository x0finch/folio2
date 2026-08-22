import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

export const DeleteTabPinInput = z.object({ pinId: z.string().min(1) });

export function handleDeleteTabPin(data: z.infer<typeof DeleteTabPinInput>) {
  return Effect.gen(function* () {
    const db = yield* Database;
    yield* db.tabPins.remove(data.pinId);
    return { ok: true as const };
  });
}

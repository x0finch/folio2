import { Database } from "@folio/db";
import { Effect } from "effect";
import type { z } from "zod";
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";
import type { AccountTagInput } from "./attach";

export const handleDetachTag = Effect.fn("detachTag")(function* (
  data: z.infer<typeof AccountTagInput>,
) {
  const out = yield* (yield* Database).tags.detach(data.accountId, data.tagId);
  yield* invalidatePrecomputed(); // 同 attach:改的是 tag pin 那一维的账户集
  return out;
});

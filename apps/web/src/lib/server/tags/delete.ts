import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";

export const DeleteTagInput = z.object({ tagId: z.string().min(1) });

export const handleDeleteTag = Effect.fn("deleteTag")(function* (
  data: z.infer<typeof DeleteTagInput>,
) {
  const out = yield* (yield* Database).tags.remove(data.tagId);
  // 指着它的 pin 随之作废(`pinsInView` 按本组合的标签集筛)—— tab 条与那一维都得重算。
  yield* invalidatePrecomputed();
  return out;
});

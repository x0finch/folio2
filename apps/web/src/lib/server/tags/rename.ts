import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";

export const RenameTagInput = z.object({
  tagId: z.string().min(1),
  name: z.string().trim().min(1, "tag name is required"),
});

export const handleRenameTag = Effect.fn("renameTag")(function* (
  data: z.infer<typeof RenameTagInput>,
) {
  const out = yield* (yield* Database).tags.rename(data.tagId, data.name);
  // tab 条上那个 Tab 的名字就是这个标签名,而它是预计算出来的 —— 不抬水位线,条上会挂着旧名字。
  yield* invalidatePrecomputed();
  return out;
});

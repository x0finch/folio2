import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";

// attach/detach 同一入参形状 —— schema 住这儿,detach 跨借。
export const AccountTagInput = z.object({
  accountId: z.string().min(1),
  tagId: z.string().min(1),
});

export const handleAttachTag = Effect.fn("attachTag")(function* (
  data: z.infer<typeof AccountTagInput>,
) {
  const out = yield* (yield* Database).tags.attach(data.accountId, data.tagId);
  // tag pin 那一维是**按这个标签的账户集**算出来的,而这一步改的正是那个集合 ——
  // 不抬水位线,那个 tab 的 24h 盈亏会一直是加标签之前的账户组合算出来的数。
  yield* invalidatePrecomputed();
  return out;
});

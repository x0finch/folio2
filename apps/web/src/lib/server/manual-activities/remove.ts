import { Effect } from "effect";
import { z } from "zod";
import { deleteManualActivity } from "@/lib/server/manual/store";
import { invalidateGain24h } from "@/lib/server/portfolio/gain";

export const RemoveActivityInput = z.object({
  accountId: z.string().min(1),
  activityId: z.string().min(1),
});

export const handleRemoveManualActivity = Effect.fn("removeManualActivity")(function* (
  data: z.infer<typeof RemoveActivityInput>,
) {
  yield* deleteManualActivity(data.accountId, data.activityId);
  // 组合的值变了 → 预计算的 24h 盈亏不再可信,就地标旧(ADR 0049;为什么标旧不是删,见那边)。
  yield* invalidateGain24h();
  return { ok: true as const };
});

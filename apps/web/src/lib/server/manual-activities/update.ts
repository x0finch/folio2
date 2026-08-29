import { Effect } from "effect";
import { z } from "zod";
import { editManualActivity } from "@/lib/server/manual/store";
import { invalidatePrecomputed } from "@/lib/server/portfolio/precompute";
import { ActivityKind } from "./create";
import { OccurredAt } from "./occurred-at";

export const UpdateActivityInput = z.object({
  activityId: z.string().min(1),
  patch: z.object({
    kind: ActivityKind.optional(),
    amount: z.number().nonnegative().optional(),
    price: z.number().nonnegative().nullish(),
    fee: z.number().nonnegative().nullish(),
    occurredAt: OccurredAt.optional(),
    memo: z.string().trim().nullish(),
  }),
});

export const handleUpdateManualActivity = Effect.fn("updateManualActivity")(function* (data: {
  activityId: string;
  patch: Parameters<typeof editManualActivity>[1];
}) {
  const result = yield* editManualActivity(data.activityId, data.patch);
  // 组合的值变了 → 预计算的 24h 盈亏不再可信,就地标旧(ADR 0049;为什么标旧不是删,见那边)。
  // 超支被拒的那一支什么都没写,不必标。
  if (result.ok) yield* invalidatePrecomputed();
  return result;
});

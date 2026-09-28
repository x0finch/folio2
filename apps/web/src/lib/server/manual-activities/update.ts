import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { editManualActivity } from "@/lib/server/manual/store";
import { refillDailyPrices } from "@/lib/server/prices/daily";
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
  return result;
});

// server fn 的那一层:改成功之后投一条定向的 `daily-prices`(FOL-90)—— 改日期可能把首笔活动
// 挪到更早,那一段日价还没补过。
export const handleUpdateManualActivityFor = Effect.fn("updateManualActivity")(function* (
  userId: string,
  data: Parameters<typeof handleUpdateManualActivity>[0],
) {
  const result = yield* handleUpdateManualActivity(data);
  if (result.ok) {
    const { accountId } = yield* (yield* Database).manual.activityOwner(data.activityId);
    yield* refillDailyPrices(userId, accountId);
  }
  return result;
});

import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import { editManualActivity } from "@/lib/server/manual/store";
import { refillDailyPrices } from "@/lib/server/prices/daily";
import { serverFn } from "@/lib/server/server-fn";
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

// Queues a `daily-prices` refill: a date edit can move the first activity earlier than backfilled.
export const handleUpdateManualActivityAndRefill = serverFn("updateManualActivity")(function* (
  data: Parameters<typeof handleUpdateManualActivity>[0],
) {
  const result = yield* handleUpdateManualActivity(data);
  if (result.ok) {
    const { accountId } = yield* (yield* Database).manual.activityOwner(data.activityId);
    yield* refillDailyPrices(accountId);
  }
  return result;
});

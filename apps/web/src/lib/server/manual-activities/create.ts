import { Effect } from "effect";
import { z } from "zod";
import { addManualActivities } from "@/lib/server/manual/store";
import { refillDailyPrices } from "@/lib/server/prices/daily";
import { serverFn } from "@/lib/server/server-fn";
import { OccurredAt } from "./occurred-at";

export const ActivityKind = z.enum(["add", "reduce", "set"]);

const BatchDraftInput = z.object({
  token: z.object({
    symbol: z.string().trim().min(1),
    unitPrice: z.number().nonnegative(),
    // Opaque picker ticket; decoded in ../manual/store, where an invalid one means "not picked".
    ticket: z.string().trim().min(1).nullish(),
  }),
  kind: ActivityKind,
  amount: z.number().nonnegative(),
  occurredAt: OccurredAt,
  price: z.number().nonnegative().nullish(),
  fee: z.number().nonnegative().nullish(),
  memo: z.string().trim().nullish(),
});

export const CreateActivitiesInput = z.object({
  accountId: z.string().min(1),
  drafts: z.array(BatchDraftInput).min(1),
});

// Atomic batch, rejected whole on oversell.
export const handleCreateManualActivities = Effect.fn("createManualActivities")(function* (data: {
  accountId: string;
  drafts: Parameters<typeof addManualActivities>[1];
}) {
  const result = yield* addManualActivities(data.accountId, data.drafts);
  return result;
});

// Queues a targeted `daily-prices` refill so new tokens' history needn't wait for the next hour.
export const handleCreateManualActivitiesAndRefill = serverFn("createManualActivities")(function* (
  data: Parameters<typeof handleCreateManualActivities>[0],
) {
  const result = yield* handleCreateManualActivities(data);
  if (result.ok) yield* refillDailyPrices(data.accountId);
  return result;
});

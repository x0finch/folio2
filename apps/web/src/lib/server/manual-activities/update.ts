import { Effect } from "effect";
import { z } from "zod";
import { editManualActivity } from "@/lib/server/manual/store";
import { ActivityKind } from "./create";

export const UpdateActivityInput = z.object({
  activityId: z.string().min(1),
  patch: z.object({
    kind: ActivityKind.optional(),
    amount: z.number().nonnegative().optional(),
    price: z.number().nonnegative().nullish(),
    fee: z.number().nonnegative().nullish(),
    occurredAt: z.number().int().optional(),
    memo: z.string().trim().nullish(),
  }),
});

export const handleUpdateManualActivity = Effect.fn("updateManualActivity")(function* (data: {
  activityId: string;
  patch: Parameters<typeof editManualActivity>[1];
}) {
  return yield* editManualActivity(data.activityId, data.patch);
});

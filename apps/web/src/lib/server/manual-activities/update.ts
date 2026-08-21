import { z } from "zod";
import { editManualActivity } from "../manual/store";
import { runRequest } from "../oracle";
import type { AuthContext } from "../session/auth-session";
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

export function handleUpdateManualActivity({
  data,
  context,
}: {
  data: { activityId: string; patch: Parameters<typeof editManualActivity>[1] };
  context: AuthContext;
}) {
  return runRequest(context.userId, editManualActivity(data.activityId, data.patch));
}

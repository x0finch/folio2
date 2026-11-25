import { z } from "zod";
import { deleteManualActivity } from "@/lib/server/manual/store";
import { serverFn } from "@/lib/server/server-fn";

export const RemoveActivityInput = z.object({
  accountId: z.string().min(1),
  activityId: z.string().min(1),
});

export const handleRemoveManualActivity = serverFn("removeManualActivity")(function* (
  data: z.infer<typeof RemoveActivityInput>,
) {
  yield* deleteManualActivity(data.accountId, data.activityId);
  return { ok: true as const };
});

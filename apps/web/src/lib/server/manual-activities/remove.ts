import { z } from "zod";
import { deleteManualActivity } from "../manual/store";
import { runRequest } from "../oracle";

export const RemoveActivityInput = z.object({
  accountId: z.string().min(1),
  activityId: z.string().min(1),
});

export async function handleRemoveManualActivity({
  data,
  context,
}: {
  data: z.infer<typeof RemoveActivityInput>;
  context: { userId: string };
}) {
  await runRequest(context.userId, deleteManualActivity(data.accountId, data.activityId));
  return { ok: true as const };
}

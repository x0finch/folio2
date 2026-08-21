import { deleteManualActivity } from "../manual/store";
import { runRequest } from "../oracle";

export async function handleRemoveManualActivity({
  data,
  context,
}: {
  data: { accountId: string; activityId: string };
  context: { userId: string };
}) {
  await runRequest(context.userId, deleteManualActivity(data.accountId, data.activityId));
  return { ok: true as const };
}

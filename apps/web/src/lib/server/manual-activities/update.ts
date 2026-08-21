import { editManualActivity } from "../manual/store";
import { runRequest } from "../oracle";

export function handleUpdateManualActivity({
  data,
  context,
}: {
  data: { activityId: string; patch: Parameters<typeof editManualActivity>[1] };
  context: { userId: string };
}) {
  return runRequest(context.userId, editManualActivity(data.activityId, data.patch));
}

import { z } from "zod";
import { deleteManualActivity } from "@/lib/server/manual/store";
import { runRequest } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";

export const RemoveActivityInput = z.object({
  accountId: z.string().min(1),
  activityId: z.string().min(1),
});

export async function handleRemoveManualActivity({
  data,
  context,
}: {
  data: z.infer<typeof RemoveActivityInput>;
  context: AuthContext;
}) {
  await runRequest(context.userId, deleteManualActivity(data.accountId, data.activityId));
  return { ok: true as const };
}

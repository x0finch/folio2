import { TagStore } from "@folio/db";
import { z } from "zod";
import { runStore } from "../oracle";
import type { AuthContext } from "../session/auth-session";

export const DeleteTagInput = z.object({ tagId: z.string().min(1) });

export function handleDeleteTag({
  data,
  context,
}: {
  data: z.infer<typeof DeleteTagInput>;
  context: AuthContext;
}) {
  return runStore(context.userId, TagStore, (s) => s.remove(data.tagId));
}

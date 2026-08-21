import { TagStore } from "@folio/db";
import { z } from "zod";
import { runStore } from "../oracle";
import type { AuthContext } from "../session/auth-session";

export const RenameTagInput = z.object({
  tagId: z.string().min(1),
  name: z.string().trim().min(1, "tag name is required"),
});

export function handleRenameTag({
  data,
  context,
}: {
  data: z.infer<typeof RenameTagInput>;
  context: AuthContext;
}) {
  return runStore(context.userId, TagStore, (s) => s.rename(data.tagId, data.name));
}

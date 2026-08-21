import { TagStore } from "@folio/db";
import type { z } from "zod";
import { runStore } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";
import type { AccountTagInput } from "./attach";

export function handleDetachTag({
  data,
  context,
}: {
  data: z.infer<typeof AccountTagInput>;
  context: AuthContext;
}) {
  return runStore(context.userId, TagStore, (s) => s.detach(data.accountId, data.tagId));
}

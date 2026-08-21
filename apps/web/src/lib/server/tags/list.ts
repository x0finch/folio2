import { TagStore } from "@folio/db";
import { runStore } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";

export function handleListTags({ context }: { context: AuthContext }) {
  return runStore(context.userId, TagStore, (s) => s.list());
}

import { TagStore } from "@folio/db";
import { runStore } from "../oracle";
import type { AuthContext } from "../session/auth-session";

export function handleListTags({ context }: { context: AuthContext }) {
  return runStore(context.userId, TagStore, (s) => s.list());
}

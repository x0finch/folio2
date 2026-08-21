import { TagStore } from "@folio/db";
import { runStore } from "../oracle";

export function handleListTags({ context }: { context: { userId: string } }) {
  return runStore(context.userId, TagStore, (s) => s.list());
}

import { TagStore } from "@folio/db";
import { runStore } from "../oracle";

export function handleDeleteTag({
  data,
  context,
}: {
  data: { tagId: string };
  context: { userId: string };
}) {
  return runStore(context.userId, TagStore, (s) => s.remove(data.tagId));
}

import { TagStore } from "@folio/db";
import { runStore } from "../oracle";

export function handleRenameTag({
  data,
  context,
}: {
  data: { tagId: string; name: string };
  context: { userId: string };
}) {
  return runStore(context.userId, TagStore, (s) => s.rename(data.tagId, data.name));
}

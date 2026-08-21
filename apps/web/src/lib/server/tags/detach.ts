import { TagStore } from "@folio/db";
import { runStore } from "../oracle";

export function handleDetachTag({
  data,
  context,
}: {
  data: { accountId: string; tagId: string };
  context: { userId: string };
}) {
  return runStore(context.userId, TagStore, (s) => s.detach(data.accountId, data.tagId));
}

import { TagStore } from "@folio/db";
import { runStore } from "../oracle";

export function handleAttachTag({
  data,
  context,
}: {
  data: { accountId: string; tagId: string };
  context: { userId: string };
}) {
  return runStore(context.userId, TagStore, (s) => s.attach(data.accountId, data.tagId));
}

import { TagStore } from "@folio/db";
import { z } from "zod";
import { runStore } from "../oracle";

// attach/detach 同一入参形状 —— schema 住这儿,detach 跨借。
export const AccountTagInput = z.object({
  accountId: z.string().min(1),
  tagId: z.string().min(1),
});

export function handleAttachTag({
  data,
  context,
}: {
  data: z.infer<typeof AccountTagInput>;
  context: { userId: string };
}) {
  return runStore(context.userId, TagStore, (s) => s.attach(data.accountId, data.tagId));
}

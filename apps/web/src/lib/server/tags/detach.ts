import { TagStore } from "@folio/db";
import type { z } from "zod";
import { runStore } from "../oracle";
import type { AccountTagInput } from "./attach";

export function handleDetachTag({
  data,
  context,
}: {
  data: z.infer<typeof AccountTagInput>;
  context: { userId: string };
}) {
  return runStore(context.userId, TagStore, (s) => s.detach(data.accountId, data.tagId));
}

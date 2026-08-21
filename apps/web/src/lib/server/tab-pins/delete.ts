import { TabPinStore } from "@folio/db";
import { runStore } from "../oracle";

export async function handleDeleteTabPin({
  data,
  context,
}: {
  data: { pinId: string };
  context: { userId: string };
}) {
  await runStore(context.userId, TabPinStore, (s) => s.remove(data.pinId));
  return { ok: true as const };
}

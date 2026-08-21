import { TabPinStore } from "@folio/db";
import { z } from "zod";
import { runStore } from "../oracle";

export const DeleteTabPinInput = z.object({ pinId: z.string().min(1) });

export async function handleDeleteTabPin({
  data,
  context,
}: {
  data: z.infer<typeof DeleteTabPinInput>;
  context: { userId: string };
}) {
  await runStore(context.userId, TabPinStore, (s) => s.remove(data.pinId));
  return { ok: true as const };
}

import { TabPinStore } from "@folio/db";
import { z } from "zod";
import { runStore } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";

export const DeleteTabPinInput = z.object({ pinId: z.string().min(1) });

export async function handleDeleteTabPin({
  data,
  context,
}: {
  data: z.infer<typeof DeleteTabPinInput>;
  context: AuthContext;
}) {
  await runStore(context.userId, TabPinStore, (s) => s.remove(data.pinId));
  return { ok: true as const };
}

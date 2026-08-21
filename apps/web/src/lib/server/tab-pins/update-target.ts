import type { ConnectorId } from "@folio/connectors";
import { TabPinStore } from "@folio/db";
import { z } from "zod";
import type { TabPinScope } from "@/lib/core/accounts-in-view";
import { runStore } from "@/lib/server/oracle";
import type { AuthContext } from "@/lib/server/session/auth-session";
import { PinTargetInput } from "./create";

export const UpdateTabPinInput = PinTargetInput.extend({ pinId: z.string().min(1) });

export async function handleUpdateTabPinTarget({
  data,
  context,
}: {
  data: NonNullable<TabPinScope> & { pinId: string };
  context: AuthContext;
}) {
  await runStore(context.userId, TabPinStore, (s) =>
    s.updateTarget(data.pinId, {
      kind: data.kind,
      connectorId: data.connectorId as ConnectorId | undefined,
      tagId: data.tagId,
      accountId: data.accountId,
    }),
  );
  return { ok: true as const };
}

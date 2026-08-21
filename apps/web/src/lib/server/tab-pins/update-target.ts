import type { ConnectorId } from "@folio/connectors";
import { TabPinStore } from "@folio/db";
import { runStore } from "../oracle";
import type { PinTargetInput } from "./create";

export async function handleUpdateTabPinTarget({
  data,
  context,
}: {
  data: PinTargetInput & { pinId: string };
  context: { userId: string };
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

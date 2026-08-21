import type { ConnectorId } from "@folio/connectors";
import { TabPinStore } from "@folio/db";
import type { TabPinScope } from "../../core/accounts-in-view";
import { runStore } from "../oracle";

export async function handleUpdateTabPinTarget({
  data,
  context,
}: {
  data: NonNullable<TabPinScope> & { pinId: string };
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

import type { ConnectorId } from "@folio/connectors";
import { TabPinStore } from "@folio/db";
import type { TabPinScope } from "../../core/accounts-in-view";
import { runStore } from "../oracle";

// pin 目标形状家在 core/accounts-in-view 的 `TabPinScope`(每 user ≤3 的上限、tag 归属校验都在 db 层)。
export function handleCreateTabPin({
  data,
  context,
}: {
  data: NonNullable<TabPinScope>;
  context: { userId: string };
}) {
  return runStore(context.userId, TabPinStore, (s) =>
    s.create({
      kind: data.kind,
      connectorId: data.connectorId as ConnectorId | undefined,
      tagId: data.tagId,
      accountId: data.accountId,
    }),
  );
}

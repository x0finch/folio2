import type { ConnectorId } from "@folio/connectors";
import { TabPinStore } from "@folio/db";
import { runStore } from "../oracle";

// pin 目标形状(每 user ≤3 的上限、tag 归属校验都在 db 层)。
export interface PinTargetInput {
  kind: "connector" | "tag" | "account";
  connectorId?: string;
  tagId?: string;
  accountId?: string;
}

export function handleCreateTabPin({
  data,
  context,
}: {
  data: PinTargetInput;
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

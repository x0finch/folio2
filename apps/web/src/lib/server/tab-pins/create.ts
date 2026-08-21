import type { ConnectorId } from "@folio/connectors";
import { TabPinStore } from "@folio/db";
import { z } from "zod";
import type { TabPinScope } from "../../core/accounts-in-view";
import { runStore } from "../oracle";

// pin 目标形状家在 core/accounts-in-view 的 `TabPinScope`(每 user ≤3 的上限、tag 归属校验都在 db 层)。
// schema 住这儿,update-target 跨借做 extend;与 TabPinScope 的一致性由 .handler() 处的赋值检查看着。
export const PinTargetInput = z.object({
  kind: z.enum(["connector", "tag", "account"]),
  connectorId: z.string().optional(),
  tagId: z.string().optional(),
  accountId: z.string().optional(),
});

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

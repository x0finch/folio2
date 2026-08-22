import type { ConnectorId } from "@folio/connectors";
import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import type { TabPinScope } from "@/lib/core/accounts-in-view";

// pin 目标形状家在 core/accounts-in-view 的 `TabPinScope`(每 user ≤3 的上限、tag 归属校验都在 db 层)。
// schema 住这儿,update-target 跨借做 extend;与 TabPinScope 的一致性由 .handler() 处的赋值检查看着。
export const PinTargetInput = z.object({
  kind: z.enum(["connector", "tag", "account"]),
  connectorId: z.string().optional(),
  tagId: z.string().optional(),
  accountId: z.string().optional(),
});

// **handler 只描述,不发动**:返回一个 Effect,「哪个用户 / 怎么装配 / 什么时候变成 Promise」
// 全在装配点的 `runEffect` 里(见 ./index.ts)。所以这里没有 `context` 参数、没有 `await`。
export function handleCreateTabPin(data: NonNullable<TabPinScope>) {
  return Effect.gen(function* () {
    const db = yield* Database;
    return yield* db.tabPins.create({
      kind: data.kind,
      connectorId: data.connectorId as ConnectorId | undefined,
      tagId: data.tagId,
      accountId: data.accountId,
    });
  });
}

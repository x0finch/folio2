import type { ConnectorId } from "@folio/connectors";
import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";
import type { TabPinScope } from "@/lib/core/accounts-in-view";
import { assertPinCap, PinTargetInput } from "./create";

export const UpdateTabPinInput = PinTargetInput.extend({ pinId: z.string().min(1) });

export const handleUpdateTabPinTarget = Effect.fn("updateTabPinTarget")(function* (
  data: NonNullable<TabPinScope> & { pinId: string },
) {
  const db = yield* Database;
  // 改指向也过上限(review 抓的洞):新目标可能让这个 pin 出现在别的组合里,把那边顶到 4 个。
  // 旧的那次出现不占名额(excludePinId)。
  yield* assertPinCap(data, data.pinId);
  yield* db.tabPins.updateTarget(data.pinId, {
    kind: data.kind,
    connectorId: data.connectorId as ConnectorId | undefined,
    tagId: data.tagId,
    accountId: data.accountId,
  });
  return { ok: true as const };
});

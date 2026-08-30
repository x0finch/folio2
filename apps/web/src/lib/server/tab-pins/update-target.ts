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
  yield* assertPinCap(data, data.pinId);
  yield* db.tabPins.updateTarget(data.pinId, {
    kind: data.kind,
    connectorId: data.connectorId as ConnectorId | undefined,
    tagId: data.tagId,
    accountId: data.accountId,
  });
  return { ok: true as const };
});

import { Database } from "@folio/db";
import { getLogger } from "@logtape/logtape";
import { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";

const log = getLogger(["folio", "web", "accounts"]);

// Irreversible; snapshots and manual activity cascade. A missing or foreign id is a silent no-op.
export const RemoveAccountInput = z.object({ accountId: z.string().min(1) });

export const handleRemoveAccount = serverFn("removeAccount")(function* (
  data: z.infer<typeof RemoveAccountInput>,
) {
  yield* (yield* Database).accounts.remove(data.accountId);
  log.info("account deleted", { accountId: data.accountId });
  return { ok: true as const };
});

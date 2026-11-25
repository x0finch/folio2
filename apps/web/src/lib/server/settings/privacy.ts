import { Database } from "@folio/db";
import { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";

// Separate from the valuation write: valuation drives read-time revaluation, privacy is display-only
// and must not trigger a recompute.
export const PrivacyInput = z.object({ hideBalances: z.boolean() });

export const handleUpdatePrivacySettings = serverFn("updatePrivacySettings")(function* (
  data: z.infer<typeof PrivacyInput>,
) {
  yield* (yield* Database).settings.update({ hideBalances: data.hideBalances });
  return { ok: true };
});

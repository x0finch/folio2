import { Database } from "@folio/db";
import { Effect } from "effect";
import { z } from "zod";

// Separate from the valuation write: valuation drives read-time revaluation, privacy is display-only
// and must not trigger a recompute.
export const PrivacyInput = z.object({ hideBalances: z.boolean() });

export const handleUpdatePrivacySettings = Effect.fn("updatePrivacySettings")(function* (
  data: z.infer<typeof PrivacyInput>,
) {
  yield* (yield* Database).settings.update({ hideBalances: data.hideBalances });
  return { ok: true };
});

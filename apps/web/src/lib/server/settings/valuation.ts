import { Database } from "@folio/db";
import { z } from "zod";
import { serverFn } from "@/lib/server/server-fn";

// Reads default when no row exists (coingecko / self-first).
export const handleGetValuationSettings = serverFn("getValuationSettings")(function* () {
  return yield* (yield* Database).settings.get();
});

// source-first uses market-source prices and recomputes the current view; history stays frozen.
export const ValuationInput = z.object({ mode: z.enum(["self-first", "source-first"]) });

export const handleUpdateValuationSettings = serverFn("updateValuationSettings")(function* (
  data: z.infer<typeof ValuationInput>,
) {
  yield* (yield* Database).settings.update({ valuationMode: data.mode });
  return { ok: true };
});

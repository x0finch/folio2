import { Oracle } from "@folio/oracle";
import { Effect } from "effect";
import { type TokenEnrichmentView, toTokenEnrichmentView } from "@/lib/core/portfolio";

// Display enrichment for all of the user's known tokens (not per portfolio / snapshot); merged client-side.
interface TokenEnrichmentData {
  enriched: [string, TokenEnrichmentView][];
}

//
// One whole-table read keyed by user_id (`enrichAll`): three queries instead of listing tokens for export and re-reading them in chunks.
export const handleGetTokenEnrichment = Effect.fn("getTokenEnrichment")(function* () {
  const records = yield* Effect.flatMap(Oracle, (o) => o.tokens.enrichAll());
  const enriched = [...records].map(
    ([id, r]) => [id, toTokenEnrichmentView(r)] as [string, TokenEnrichmentView],
  );
  return { enriched } satisfies TokenEnrichmentData;
});

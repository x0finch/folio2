import type { CacheStore, DbRequest } from "@folio/db";
import { DatabaseForOracle } from "@folio/db";
import type { TokenCandidate } from "@folio/oracle-basic";
import { DEFAULT_TOP_N, normalizeSymbol } from "@folio/oracle-basic";
import type { TokenMetaUpstream } from "@folio/upstream-basic";
import { TokenUpstream } from "@folio/upstream-basic/ports";
import { Context, Effect, Layer } from "effect";
import { type WarmRow, warmBlob } from "./warm";

// Candidate source for mint's symbol tier; a package-internal Tag consumed by `oracleLayer` when wiring `TokenService`.
// It owns the catalogue's single egress path (the cold-cache fetch) and mint only gets its `bySymbol`, so mint's scope has no `*Upstream`.
// It is also mint's injection seam: tests replace it via Layer, keeping one construction path for tests and production.
// Egress cannot be banned by type (the cold-cache fetch is unavoidable: an empty candidate set means no symbol-matched token is recognised).
// It is confined to this one service so whoever provides it can see it.
// Third reader of the warm blob (others in ./catalogue); see ./warm for why the criteria differ.

/** Catalogue reader: uses whatever exists however old, and fetches once only when there is none (user_cache never deletes on expiry, so once per lifetime). */
export const warmCatalogue = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
): Effect.Effect<readonly WarmRow[], never, DbRequest> =>
  warmBlob(cache, upstream, topN, () => false);

// Filter candidates by symbol; same rows as the leaderboard, no second copy.
export function candidatesBySymbol(rows: readonly WarmRow[], symbol: string): TokenCandidate[] {
  const want = normalizeSymbol(symbol);
  const out: TokenCandidate[] = [];
  for (const r of rows) {
    if (normalizeSymbol(r.info.symbol) !== want) continue;
    out.push({ ref: r.info.ref, marketCapRank: r.price.marketCapRank });
  }
  return out;
}

// Service shape is derived from the `effect` return value; `.Default` is its layer.
export class CandidateSource extends Context.Service<CandidateSource>()("oracle/CandidateSource", {
  make: Effect.gen(function* () {
    const { cache } = yield* DatabaseForOracle;
    // The only egress, called only when the cache is empty (see `warmCatalogue`).
    const coldStart = yield* TokenUpstream;
    return {
      bySymbol: (symbol: string): Effect.Effect<TokenCandidate[], never, DbRequest> =>
        Effect.map(warmCatalogue(cache, coldStart, DEFAULT_TOP_N), (rows) =>
          candidatesBySymbol(rows, symbol),
        ),
    };
  }),
}) {
  static readonly layer = Layer.effect(this, this.make);
}

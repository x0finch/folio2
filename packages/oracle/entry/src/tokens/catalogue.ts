import type { CacheStore, DbRequest } from "@folio/db";
import type { UpstreamToken } from "@folio/oracle-basic";
import { DEFAULT_TOP_N, PRICE_TTL_MS, WARM_TTL_MS } from "@folio/oracle-basic";
import type { TokenMetaUpstream, UpstreamError } from "@folio/upstream-basic";
import type { TokenUpstream } from "@folio/upstream-basic/ports";
import { Clock, Effect, Option } from "effect";
import { WARM_KEY, type WarmRow, warmBlob } from "./warm";

// Token catalogue: what a user sees when choosing a token (default top-N by market cap, and search). Public and user-independent,
// lives in the warm blob, so this slice touches no store, only `CacheStore` + upstream.
// `search` is the only method that surfaces upstream errors: it has no stale value to fall back to, and swallowing
// would show an empty list that reads as "token not found".
export interface TokenCatalogue {
  // Picker showcase: top-N by market cap from the warm blob (warms when cold; refreshes stale prices since the user is looking).
  topTokens(limit: number): Effect.Effect<UpstreamToken[], never, DbRequest>;
  // Search by keyword; always fetched from upstream (results are user-independent, edge cache handles it). Surfaces upstream errors.
  search(query: string): Effect.Effect<UpstreamToken[], UpstreamError>;
  // Background warm: refreshes the whole catalogue when older than WARM_TTL_MS (one week), otherwise zero requests; returns the entry count.
  // The only path that proactively refreshes the catalogue; call it best-effort (post-sync `waitUntil`).
  refreshCatalogue(): Effect.Effect<number, never, DbRequest>;
}

// The warm blob's two readers (third is the candidate source in ./candidates); see ./warm for why the criteria differ.

/** Showcase reader: refreshes stale prices, since the user opened the picker and can afford the round trip. */
export const warmMarkets = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
): Effect.Effect<readonly WarmRow[], never, DbRequest> =>
  warmBlob(cache, upstream, topN, (blob, now) => now - blob.asOf > PRICE_TTL_MS);

/** Warm reader (post-sync, background): refreshes the whole catalogue when stale; the only proactive path, since the other readers never refresh or only run when the picker opens. */
export const refreshWarmCatalogue = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
): Effect.Effect<readonly WarmRow[], never, DbRequest> =>
  warmBlob(cache, upstream, topN, (blob, now) => now - blob.asOf > WARM_TTL_MS);

/** Cheap freshness check on the blob's own `asOf` without decoding the 1000 rows (decode cost ~16ms of the 10ms budget). Same criterion as `refreshWarmCatalogue`; not fresh / missing / malformed gives `none` and takes the full path. A blob with fresh `asOf` but bad rows lingers until expiry; row readers decode fully and heal. Count is deduped by ref. */
const freshCatalogueSize = (
  cache: CacheStore,
  now: number,
): Effect.Effect<Option.Option<number>, never, DbRequest> =>
  Effect.map(cache.get(WARM_KEY), (hit) =>
    Option.flatMap(hit, ({ value }) => {
      const blob = value as { asOf?: unknown; rows?: unknown } | null;
      if (typeof blob?.asOf !== "number" || !Array.isArray(blob.rows)) return Option.none();
      if (now - blob.asOf > WARM_TTL_MS) return Option.none();
      const refs = new Set<unknown>();
      for (const row of blob.rows as { info?: { ref?: unknown } }[]) refs.add(row?.info?.ref);
      return Option.some(refs.size);
    }),
  );

// Top `limit` by market cap ascending rank (unranked last).
export function topByRank(rows: readonly WarmRow[], limit: number): readonly WarmRow[] {
  const rank = (r: WarmRow) => r.price.marketCapRank ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

export const makeCatalogue = (cache: CacheStore, upstream: TokenUpstream): TokenCatalogue => {
  // Showcase reader: refresh stale prices (the user is looking). The candidate source does not take this path; see ./candidates.
  const rows = warmMarkets(cache, upstream, DEFAULT_TOP_N);

  return {
    topTokens: (limit) =>
      Effect.map(rows, (all) =>
        topByRank(all, limit).map(
          (r): UpstreamToken => ({
            ref: r.info.ref,
            symbol: r.info.symbol,
            name: r.info.name,
            logo: r.info.logo,
            price: r.price,
          }),
        ),
      ),

    search: (query) => upstream.searchTokens(query),

    refreshCatalogue: () =>
      Effect.gen(function* () {
        const fresh = yield* freshCatalogueSize(cache, yield* Clock.currentTimeMillis);
        if (Option.isSome(fresh)) return fresh.value;
        return (yield* refreshWarmCatalogue(cache, upstream, DEFAULT_TOP_N)).length;
      }),
  };
};

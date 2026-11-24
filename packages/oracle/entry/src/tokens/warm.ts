import type { CacheStore, DbRequest } from "@folio/db";
import { WARM_TTL_MS } from "@folio/oracle-basic";
import type { TokenMetaUpstream } from "@folio/upstream-basic";
import { Clock, Effect, Option, Schema } from "effect";
import { swr } from "./swr";

// Top-N by market cap as one JSON blob under the per-user cache's `warm` key. Whole-read data is a blob; row-picked data
// (the global map) is a table. Symbol candidates are not stored separately: they are a subset of this blob.
// One blob, three readers, different freshness criteria: price/24h change lives minutes, rank days, symbol/name/logo almost forever.
// The blob is read and written whole, so it cannot refresh at the shortest lifetime (mint, on the write path, would wait on
// 4 catalogue requests); each reader judges by the blob's own `asOf` instead (hence `isStale`), never the cache entry's `stale`:
//   `warmCatalogue`    candidate source (mint)  in candidates.ts: never refreshes
//   `warmMarkets`      picker dropdown          in catalogue.ts: refreshes when prices are old
//   `refreshCatalogue` post-sync background     in catalogue.ts: refreshes when the catalogue is old
// Functions take resolved service objects (`cache` / `upstream`), so their `R` has only `DbRequest`; Tags are read only at the Layer level.

export const WARM_KEY = "warm";

// Shapes stored in the cache are declared and decoded via Schema, not `as`: these blobs are ours, so a wrong shape is an old
// version's output or a hand edit, and undecodable counts as a miss that heals by refetching.
const TokenPriceShape = Schema.Struct({
  unitPrice: Schema.Number,
  change24h: Schema.optional(Schema.Number),
  marketCapRank: Schema.optional(Schema.Number),
  asOf: Schema.Number,
});

// Warm's info is not in the db yet: no internal id, `ref` always non-empty (same source as `UpstreamToken`), and no `infoStale`
// (that asks whether the db row needs a refetch; this is fresh from upstream).
const WarmInfoShape = Schema.Struct({
  ref: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  logo: Schema.optional(Schema.String),
});

// The warm blob: one whole write, one whole read; rows are `{ info, price }` pairs.
const WarmBlobShape = Schema.Struct({
  asOf: Schema.Number,
  rows: Schema.Array(Schema.Struct({ info: WarmInfoShape, price: TokenPriceShape })),
});

export type WarmBlob = Schema.Schema.Type<typeof WarmBlobShape>;
export type WarmRow = WarmBlob["rows"][number];

const decodeWarm = Schema.decodeUnknownOption(WarmBlobShape);

export const warmBlob = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
  isStale: (blob: WarmBlob, now: number) => boolean,
): Effect.Effect<readonly WarmRow[], never, DbRequest> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const read = Effect.map(cache.get(WARM_KEY), (hit) =>
      // Missing / undecodable: fetch (unavoidable)
      Option.flatMap(hit, (entry) =>
        Option.map(decodeWarm(entry.value), (value) => ({ value, stale: isStale(value, now) })),
      ),
    );

    const fetch = Effect.map(upstream.fetchMarkets({ topN }), (tokens) =>
      Option.some<WarmBlob>({
        asOf: now,
        rows: tokens.map((t) => ({
          info: { symbol: t.symbol, name: t.name, logo: t.logo, ref: t.ref },
          price: t.price ?? { unitPrice: 0, asOf: now },
        })),
      }),
    );

    const blob = yield* read.pipe(
      swr("cache.warm", fetch, (value) =>
        // One whole write, not per-row upserts: top-N is a snapshot and per-row writes could leave a half-new board.
        cache.put(WARM_KEY, value, WARM_TTL_MS),
      ),
    );
    return dedupeByRef(Option.match(blob, { onNone: () => [], onSome: (b) => b.rows }));
  });

// The catalogue is a set (one row per token). Deduped on the read side so an already-cached dirty blob heals (refreshed
// weekly) and all three readers are covered. Duplicates are real: upstream pages come from different snapshots, and a
// duplicate silently makes a token compete against itself by symbol, or a duplicate React key leaves zombie rows.
function dedupeByRef(rows: readonly WarmRow[]): readonly WarmRow[] {
  const seen = new Set<string>();
  const out: WarmRow[] = [];
  for (const r of rows) {
    if (seen.has(r.info.ref)) continue; // first occurrence wins (ranked higher)
    seen.add(r.info.ref);
    out.push(r);
  }
  return out;
}

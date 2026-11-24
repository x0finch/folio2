import type { DbRequest, TokenPriceStore, TokenStore } from "@folio/db";
import type { TokenPrice, TokenRecord, TokenRecordPrice, TokenRef } from "@folio/oracle-basic";
import type { TokenUpstream } from "@folio/oracle-basic/ports";
import { Effect, Option } from "effect";
import { degradeTo } from "./swr";

// Reads: current price + row enrichment, both by internal id (or ref when picking), never reverse-derived from tokenRef.
// Row enrichment (`enrich` / `logoUrlById`) is zero network: stale prices are served as is (`TokenRecord.price.stale`); refreshing
// is `./stale`'s job, so enriching a screen of holdings never triggers upstream requests.
// Current price has two tiers by whether an internal id exists:
//   `pricesOf`                    takes token_id: price store only, zero network (one read per batch)
//   `priceByRef` / `pricesByRefs` takes tokenRef: fetched live, no row created, no cache written
// Upstream refresh lives only in `./stale`'s `refreshStale` (batches of 100, hourly `prices` job); sync revaluation must not
// call upstream per holding or it exceeds the free plan's 50 subrequests.
// The ref tier cannot merge into the id tier: while picking a token no row exists yet (mint creates it on submit), so there is no token_id to write a price to.
// Two homes of current price are accepted: held tokens in the price store (for valuation), the picker list in the warm blob; they may differ by minutes.

export interface TokenReading {
  // Enrich: batch-read full rows by internal id (info + price merged); needs no symbol or tokenRef.
  enrich(ids: readonly string[]): Effect.Effect<Map<string, TokenRecord>, never, DbRequest>;
  // Enrich every token this user knows (whole-table `enrich`), without listing ids first.
  enrichAll(): Effect.Effect<Map<string, TokenRecord>, never, DbRequest>;
  // Upstream logo URL of a row by primary key (logo proxy endpoint): source's own first, else the connector's.
  logoUrlById(id: string): Effect.Effect<Option.Option<string>, never, DbRequest>;
}

export interface TokenPricing {
  // Current prices of a batch of token_ids, price store only: no freshness check, no upstream, no write-back (stale ones served with the flag).
  // Absent ids are not in the result. Sync revaluation uses this since it is on the write path.
  pricesOf(
    tokenIds: readonly string[],
  ): Effect.Effect<Map<string, TokenRecordPrice>, never, DbRequest>;
  // Picker unit-price prefill: fetched by ref, no row created, no cache written; `none` if unavailable (the user fills it in).
  priceByRef(ref: TokenRef): Effect.Effect<Option.Option<TokenPrice>>;
  // Picker SWR price refresh: a batch of refs fetched live (batch `priceByRef`), no row, no cache; upstream failure gives an empty Map.
  pricesByRefs(refs: readonly TokenRef[]): Effect.Effect<Map<TokenRef, TokenPrice>>;
}

export const makeReading = (store: TokenStore, prices: TokenPriceStore): TokenReading => ({
  enrich: (ids) =>
    Effect.gen(function* () {
      if (ids.length === 0) return new Map<string, TokenRecord>();
      // Each store reads its own half and the service composes the row, which is what the split ports are for.
      // Concurrency is explicit.
      const [infos, priced] = yield* Effect.all([store.getByIds(ids), prices.getByIds(ids)], {
        concurrency: 2,
      });
      const out = new Map<string, TokenRecord>();
      for (const [id, info] of infos) out.set(id, { ...info, price: priced.get(id) });
      return out;
    }),

  enrichAll: () =>
    Effect.gen(function* () {
      const [infos, priced] = yield* Effect.all([store.getAll(), prices.getAll()], {
        concurrency: 2,
      });
      const out = new Map<string, TokenRecord>();
      for (const [id, info] of infos) out.set(id, { ...info, price: priced.get(id) });
      return out;
    }),

  logoUrlById: (id) =>
    Effect.map(store.getById(id), (info) =>
      Option.flatMap(info, (i) => Option.fromNullishOr(i.logo ?? i.providerLogo)),
    ),
});

export const makePricing = (prices: TokenPriceStore, upstream: TokenUpstream): TokenPricing => ({
  // Empty input skipping the query is the store's own guard (start of `getByIds`).
  pricesOf: (tokenIds) => prices.getByIds(tokenIds),

  priceByRef: (ref) =>
    upstream.fetchPrices([ref]).pipe(
      Effect.map((found) => Option.fromNullishOr(found.get(ref))),
      degradeTo("tokens.priceByRef", Option.none<TokenPrice>()),
    ),

  pricesByRefs: (refs) =>
    refs.length === 0
      ? Effect.succeed(new Map<TokenRef, TokenPrice>())
      : // upstream already chunks by IDS_PER_REQUEST; hand it the whole batch.
        upstream
          .fetchPrices(refs)
          .pipe(degradeTo("tokens.pricesByRefs", new Map<TokenRef, TokenPrice>())),
});

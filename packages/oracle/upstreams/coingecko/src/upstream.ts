import type { CoinGeckoConfig } from "@folio/coingecko-client";
import type {
  RefIndexFetch,
  TokenPrice,
  TokenPricePoint,
  TokenRef,
  UpstreamToken,
} from "@folio/oracle-basic";
import { TokenUpstream } from "@folio/oracle-basic/ports";
import type { UpstreamError } from "@folio/upstream-basic";
import { Clock, Effect, Layer } from "effect";
import { IDS_PER_REQUEST, MARKETS_PER_PAGE, UPSTREAM_ID, VS_USD } from "./constants";
import { closeOver, type Needs } from "./layer";
import { coinIdOf, parseMarkets, parsePriceSeries, parseSearch, parseSimplePrice } from "./parse";
import { toRefIndexRows } from "./ref-index";
import { req, withClient } from "./runtime";

export type { CoinGeckoConfig };

// Split ids into chunks <= size so the GET ids string does not trigger a 414 (see constants.IDS_PER_REQUEST).
function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Implementation face of `TokenUpstream` (`R` carries client and `HttpClient`); layer.ts narrows it to `R = never`.
// Exported for tests so they can provide fake transport, clock and rate-limit tiers.
export function makeUpstreamEffects() {
  return {
    // Dedupe across pages: pages are cut from different snapshots, so a coin whose market cap was revised can appear
    // on two pages (43 of 1000 observed). Duplicates would make a coin compete against itself by symbol and never
    // be recognised. Fewer than topN results is accepted: refilling needs more pages that collide too.
    // Keep pages sequential: concurrency only drains burst quota faster and slows foreground requests.
    fetchMarkets: ({
      topN,
    }: {
      topN: number;
    }): Effect.Effect<UpstreamToken[], UpstreamError, Needs> =>
      withClient((client) =>
        Effect.gen(function* () {
          const pages = Math.max(1, Math.ceil(topN / MARKETS_PER_PAGE));
          const out: UpstreamToken[] = [];
          const seen = new Set<string>();
          for (let page = 1; page <= pages; page++) {
            const rows = yield* req(
              client.coinsMarkets({
                vsCurrency: VS_USD,
                order: "market_cap_desc",
                perPage: MARKETS_PER_PAGE,
                page,
                priceChangePercentage: "24h",
              }),
            );
            for (const token of parseMarkets(rows)) {
              if (seen.has(token.ref)) continue; // first occurrence wins (ranked higher)
              seen.add(token.ref);
              out.push(token);
            }
            if (rows.length < MARKETS_PER_PAGE) break; // upstream has no more
          }
          return out.slice(0, topN);
        }),
      ),

    searchTokens: (query: string): Effect.Effect<UpstreamToken[], UpstreamError, Needs> =>
      withClient((client) => Effect.map(req(client.search(query)), parseSearch)),

    // Chunk ids: one giant `ids=` makes the URL too long and CoinGecko answers 414. Merge into one Map.
    fetchPrices: (
      refs: readonly TokenRef[],
    ): Effect.Effect<Map<TokenRef, TokenPrice>, UpstreamError, Needs> =>
      withClient((client) =>
        Effect.gen(function* () {
          const ids = refs.map(coinIdOf).filter((id): id is string => id != null);
          if (ids.length === 0) return new Map<TokenRef, TokenPrice>();
          const now = yield* Clock.currentTimeMillis;
          const merged = new Map<TokenRef, TokenPrice>();
          for (const batch of chunk(ids, IDS_PER_REQUEST)) {
            const json = yield* req(
              client.simplePrice({
                ids: batch,
                vsCurrencies: [VS_USD],
                include24hrChange: true,
                includeLastUpdatedAt: true,
              }),
            );
            for (const [ref, price] of parseSimplePrice(json, now)) merged.set(ref, price);
          }
          return merged;
        }),
      ),

    // Row lookup by id via `/coins/markets?ids=` (not `/simple/price`, which lacks name/symbol/image); chunked like above.
    fetchTokens: (
      refs: readonly TokenRef[],
    ): Effect.Effect<UpstreamToken[], UpstreamError, Needs> =>
      withClient((client) =>
        Effect.gen(function* () {
          const ids = refs.map(coinIdOf).filter((id): id is string => id != null);
          if (ids.length === 0) return [];
          const out: UpstreamToken[] = [];
          for (const batch of chunk(ids, IDS_PER_REQUEST)) {
            const rows = yield* req(
              client.coinsMarkets({
                vsCurrency: VS_USD,
                ids: batch,
                perPage: MARKETS_PER_PAGE,
                priceChangePercentage: "24h",
              }),
            );
            out.push(...parseMarkets(rows));
          }
          return out;
        }),
      ),

    // vsCurrency defaults to USD; fiat history derivation passes `<code>`, which upstream wants lowercase.
    fetchPriceSeries: (
      ref: TokenRef,
      fromMs: number,
      toMs: number,
      vsCurrency: string = VS_USD,
    ): Effect.Effect<TokenPricePoint[], UpstreamError, Needs> =>
      Effect.suspend(() => {
        const id = coinIdOf(ref);
        if (!id) return Effect.succeed([]); // not our ref: no history from this upstream
        return withClient((client) =>
          Effect.map(
            req(
              client.coinsMarketChartRange({
                id,
                vsCurrency: vsCurrency.trim().toLowerCase(),
                fromSec: Math.floor(fromMs / 1000),
                toSec: Math.ceil(toMs / 1000),
              }),
            ),
            parsePriceSeries,
          ),
        );
      }),

    // Two calls: the full coin catalogue (with contract addresses) and the platform table (for chain_identifier).
    fetchRefIndex: (): Effect.Effect<RefIndexFetch, UpstreamError, Needs> =>
      withClient((client) =>
        Effect.map(
          Effect.all([req(client.coinsList), req(client.assetPlatforms)], { concurrency: 2 }),
          ([coins, platformList]) => toRefIndexRows(coins, platformList),
        ),
      ),
  };
}

// Port wiring only: closes each method's `R` (client + HttpClient) at build time.
const make = Effect.map(closeOver, (close): TokenUpstream => {
  const impl = makeUpstreamEffects();
  return {
    id: UPSTREAM_ID,
    fetchMarkets: (opts) => close(impl.fetchMarkets(opts)),
    searchTokens: (query) => close(impl.searchTokens(query)),
    fetchPrices: (refs) => close(impl.fetchPrices(refs)),
    fetchTokens: (refs) => close(impl.fetchTokens(refs)),
    fetchPriceSeries: (ref, fromMs, toMs, vsCurrency) =>
      close(impl.fetchPriceSeries(ref, fromMs, toMs, vsCurrency)),
    fetchRefIndex: () => close(impl.fetchRefIndex()),
  };
});

/** Mounted on a given transport; the only export path is `coinGeckoUpstreamLayers`. */
export const tokenUpstreamOn = (t: Layer.Layer<Needs>): Layer.Layer<TokenUpstream> =>
  Layer.provide(Layer.effect(TokenUpstream, make), t);

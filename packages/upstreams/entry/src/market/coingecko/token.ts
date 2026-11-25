import type {
  RefIndexFetch,
  TokenPrice,
  TokenPricePoint,
  TokenRef,
  UpstreamToken,
} from "@folio/oracle-basic";
import type { UpstreamError } from "@folio/upstream-basic";
import { TokenUpstream } from "@folio/upstream-basic/ports";
import { Clock, Effect, Layer } from "effect";
import {
  assetPlatforms,
  coinsList,
  coinsMarkets,
  marketChartRange,
  search,
  simplePrice,
} from "./api";
import { ID, IDS_PER_REQUEST, MARKETS_PER_PAGE, VS_USD } from "./constants";
import { coinIdOf, parseMarkets, parsePriceSeries, parseSearch, parseSimplePrice } from "./parse";
import { toRefIndexRows } from "./ref-index";
import { closeOver, type Needs, req, withCall } from "./upstream";

function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// `TokenUpstream` with `R` still open, so tests can provide fake transport, clock and rate-limit scope.
export function makeTokenEffects() {
  return {
    // Pages are cut from different snapshots, so a coin whose market cap was revised can appear on
    // two pages (43 of 1000 observed); a duplicate would compete against itself by symbol and never
    // be recognised. Fewer than topN is accepted: refilling needs more pages that collide too.
    fetchMarkets: ({
      topN,
    }: {
      topN: number;
    }): Effect.Effect<UpstreamToken[], UpstreamError, Needs> =>
      withCall((call) =>
        Effect.gen(function* () {
          const pages = Math.max(1, Math.ceil(topN / MARKETS_PER_PAGE));
          const out: UpstreamToken[] = [];
          const seen = new Set<string>();
          for (let page = 1; page <= pages; page++) {
            const rows = yield* req(
              coinsMarkets(call, {
                vsCurrency: VS_USD,
                order: "market_cap_desc",
                perPage: MARKETS_PER_PAGE,
                page,
                priceChangePercentage: "24h",
              }),
            );
            for (const token of parseMarkets(rows)) {
              if (seen.has(token.ref)) continue; // the first ranks higher
              seen.add(token.ref);
              out.push(token);
            }
            if (rows.length < MARKETS_PER_PAGE) break;
          }
          return out.slice(0, topN);
        }),
      ),

    searchTokens: (query: string): Effect.Effect<UpstreamToken[], UpstreamError, Needs> =>
      withCall((call) => Effect.map(req(search(call, query)), parseSearch)),

    fetchPrices: (
      refs: readonly TokenRef[],
    ): Effect.Effect<Map<TokenRef, TokenPrice>, UpstreamError, Needs> =>
      withCall((call) =>
        Effect.gen(function* () {
          const ids = refs.map(coinIdOf).filter((id): id is string => id != null);
          if (ids.length === 0) return new Map<TokenRef, TokenPrice>();
          const now = yield* Clock.currentTimeMillis;
          const merged = new Map<TokenRef, TokenPrice>();
          for (const batch of chunk(ids, IDS_PER_REQUEST)) {
            const json = yield* req(
              simplePrice(call, {
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

    // `/coins/markets?ids=`, not `/simple/price`: only it carries name, symbol and image.
    fetchTokens: (
      refs: readonly TokenRef[],
    ): Effect.Effect<UpstreamToken[], UpstreamError, Needs> =>
      withCall((call) =>
        Effect.gen(function* () {
          const ids = refs.map(coinIdOf).filter((id): id is string => id != null);
          if (ids.length === 0) return [];
          const out: UpstreamToken[] = [];
          for (const batch of chunk(ids, IDS_PER_REQUEST)) {
            const rows = yield* req(
              coinsMarkets(call, {
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

    // Fiat history derivation passes `<code>`, which upstream wants lowercase.
    fetchPriceSeries: (
      ref: TokenRef,
      fromMs: number,
      toMs: number,
      vsCurrency: string = VS_USD,
    ): Effect.Effect<TokenPricePoint[], UpstreamError, Needs> =>
      Effect.suspend(() => {
        const id = coinIdOf(ref);
        if (!id) return Effect.succeed([]);
        return withCall((call) =>
          Effect.map(
            req(
              marketChartRange(call, {
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

    // The platform table supplies chain_identifier for the catalogue's contract addresses.
    fetchRefIndex: (): Effect.Effect<RefIndexFetch, UpstreamError, Needs> =>
      withCall((call) =>
        Effect.map(
          Effect.all([req(coinsList(call)), req(assetPlatforms(call))], { concurrency: 2 }),
          ([coins, platforms]) => toRefIndexRows(coins, platforms),
        ),
      ),
  };
}

const make = Effect.map(closeOver, (close): TokenUpstream => {
  const impl = makeTokenEffects();
  return {
    id: ID,
    fetchMarkets: (opts) => close(impl.fetchMarkets(opts)),
    searchTokens: (query) => close(impl.searchTokens(query)),
    fetchPrices: (refs) => close(impl.fetchPrices(refs)),
    fetchTokens: (refs) => close(impl.fetchTokens(refs)),
    fetchPriceSeries: (ref, fromMs, toMs, vsCurrency) =>
      close(impl.fetchPriceSeries(ref, fromMs, toMs, vsCurrency)),
    fetchRefIndex: () => close(impl.fetchRefIndex()),
  };
});

export const tokenUpstreamOn = (transport: Layer.Layer<Needs>): Layer.Layer<TokenUpstream> =>
  Layer.provide(Layer.effect(TokenUpstream, make), transport);

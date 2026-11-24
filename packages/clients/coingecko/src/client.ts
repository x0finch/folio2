import {
  makeRateLimit,
  makeRequester,
  type Outbound,
  type Requester,
  type UpstreamError,
} from "@folio/client-core";
import { Context, Duration, Effect, Layer, Schema, type Scope } from "effect";
import {
  CG_BASE_FREE,
  CG_BASE_PRO,
  CG_BURST,
  CG_CALLS_PER_MIN_DEMO,
  CG_CALLS_PER_MIN_KEYLESS,
  CG_CALLS_PER_MIN_PRO,
  CG_LIMIT_KEY,
  CG_LIMIT_KEY_KEYLESS,
  HEADER_DEMO,
  HEADER_PRO,
  UPSTREAM,
  USER_AGENT,
} from "./constants";
import {
  AssetPlatform,
  CoinContract,
  CoinListItem,
  DerivativesExchange,
  Exchange,
  ExchangeRates,
  MarketCoin,
  SearchResult,
  SimplePriceMap,
} from "./types";

export interface CoinGeckoConfig {
  // With a key, sends it and picks base and quota by tier. Works without one (keyless tier, quota per egress IP).
  readonly apiKey?: string;
  readonly pro?: boolean;
  readonly baseUrl?: string;
}

export interface CoinsMarketsParams {
  readonly vsCurrency: string;
  readonly ids?: readonly string[];
  readonly order?: string;
  readonly perPage?: number;
  readonly page?: number;
  readonly priceChangePercentage?: string;
}

export interface SimplePriceParams {
  readonly ids: readonly string[];
  readonly vsCurrencies: readonly string[];
  readonly include24hrChange?: boolean;
  readonly includeLastUpdatedAt?: boolean;
}

export interface CoinsMarketChartRangeParams {
  readonly id: string;
  readonly vsCurrency: string;
  readonly fromSec: number;
  readonly toSec: number;
}

// Request layer for CoinGecko v3: one typed method per endpoint, returning the upstream shape (DTO). Token recognition, valuation
// policy and ref indexing live on the oracle side. No retry of its own: the caller adds `Effect.retry(policy)` outside.
export interface CoinGeckoClientApi {
  readonly assetPlatforms: Effect.Effect<readonly AssetPlatform[], UpstreamError, Outbound>;
  readonly coinsList: Effect.Effect<readonly CoinListItem[], UpstreamError, Outbound>;
  readonly coinsMarkets: (
    params: CoinsMarketsParams,
  ) => Effect.Effect<readonly MarketCoin[], UpstreamError, Outbound>;
  readonly simplePrice: (
    params: SimplePriceParams,
  ) => Effect.Effect<SimplePriceMap, UpstreamError, Outbound>;
  // Historical daily price series; the output is the `prices` column, since upstream wraps it in an object whose wrapper carries nothing.
  readonly coinsMarketChartRange: (
    params: CoinsMarketChartRangeParams,
  ) => Effect.Effect<readonly (readonly [number, number])[], UpstreamError, Outbound>;
  readonly search: (query: string) => Effect.Effect<SearchResult, UpstreamError, Outbound>;
  // Coin by contract. Not found is a normal answer (not every contract is in CGK's database): null, not a failure.
  readonly coinContract: (
    platform: string,
    address: string,
  ) => Effect.Effect<CoinContract | null, UpstreamError, Outbound>;
  readonly exchange: (id: string) => Effect.Effect<Exchange | null, UpstreamError, Outbound>;
  readonly derivativesExchange: (
    id: string,
  ) => Effect.Effect<DerivativesExchange | null, UpstreamError, Outbound>;
  readonly exchangeRates: Effect.Effect<ExchangeRates, UpstreamError, Outbound>;
}

export class CoinGeckoClient extends Context.Service<CoinGeckoClient, CoinGeckoClientApi>()(
  "clients/CoinGecko",
) {
  static readonly layer = (config: CoinGeckoConfig = {}): Layer.Layer<CoinGeckoClient> =>
    Layer.effect(CoinGeckoClient, make(config));
}

export function make(
  config: CoinGeckoConfig = {},
): Effect.Effect<CoinGeckoClientApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const callsPerMin = config.pro
      ? CG_CALLS_PER_MIN_PRO
      : config.apiKey
        ? CG_CALLS_PER_MIN_DEMO
        : CG_CALLS_PER_MIN_KEYLESS;

    // CGK most needs the gate: one key is shared across the deployment and every user's call spends the same quota (catalogue warm 4 pages,
    // two concurrent for the ref index, search, on-demand prices, history), the opposite of "each account spends its own".
    // The gate key varies with whether there is a key: per-key quota with a key, per-egress-IP without; those are two separate
    // quotas that must not queue together.
    const limit = yield* makeRateLimit({
      key: config.apiKey ? CG_LIMIT_KEY : CG_LIMIT_KEY_KEYLESS,
      limit: CG_BURST,
      // Allow CG_BURST per interval, converted to upstream's "calls per minute" convention.
      interval: Duration.millis((CG_BURST / (callsPerMin / 60)) * 1000),
    });

    const headers: Record<string, string> = {
      accept: "application/json",
      // The UA must be sent: Workers' fetch sends none and CGK's Cloudflare WAF answers 403 without one.
      "user-agent": USER_AGENT,
    };
    if (config.apiKey) headers[config.pro ? HEADER_PRO : HEADER_DEMO] = config.apiKey;

    const request: Requester = makeRequester({
      baseUrl: config.baseUrl ?? (config.pro ? CG_BASE_PRO : CG_BASE_FREE),
      upstream: UPSTREAM,
      limit,
      headers: () => Effect.succeed(headers),
    });

    // No top-level shape guard: the schema covers it, along with field types.
    return {
      assetPlatforms: request("/asset_platforms", Schema.Array(AssetPlatform)),

      coinsList: request("/coins/list", Schema.Array(CoinListItem), {
        query: { include_platform: "true" },
      }),

      coinsMarkets: (params) =>
        request("/coins/markets", Schema.Array(MarketCoin), {
          query: {
            vs_currency: params.vsCurrency,
            ids: params.ids?.join(","),
            order: params.order,
            per_page: params.perPage,
            page: params.page,
            price_change_percentage: params.priceChangePercentage,
          },
        }),

      simplePrice: (params) =>
        request("/simple/price", SimplePriceMap, {
          query: {
            ids: params.ids.join(","),
            vs_currencies: params.vsCurrencies.join(","),
            // Keys that are `undefined` are left out: sending "false" and omitting are not the same to CGK.
            include_24hr_change: params.include24hrChange ? "true" : undefined,
            include_last_updated_at: params.includeLastUpdatedAt ? "true" : undefined,
          },
        }),

      // The output is the `prices` column; upstream wraps it in an object whose wrapper carries nothing.
      // A missing `prices` is a validation failure, in the same error channel.
      coinsMarketChartRange: (params) =>
        request(
          `/coins/${params.id}/market_chart/range`,
          Schema.Struct({ prices: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])) }),
          { query: { vs_currency: params.vsCurrency, from: params.fromSec, to: params.toSec } },
        ).pipe(Effect.map((res) => res.prices)),

      search: (query) => request("/search", SearchResult, { query: { query } }),

      coinContract: (platform, address) =>
        request(
          `/coins/${platform}/contract/${address.toLowerCase()}`,
          CoinContract,
          // Not found gives null: not every contract is in CGK's database, a normal answer rather than a fault.
          { notFoundAsNull: true },
        ),

      exchange: (id) => request(`/exchanges/${id}`, Exchange, { notFoundAsNull: true }),

      derivativesExchange: (id) =>
        request(`/derivatives/exchanges/${id}`, DerivativesExchange, { notFoundAsNull: true }),

      exchangeRates: request("/exchange_rates", ExchangeRates),
    };
  });
}

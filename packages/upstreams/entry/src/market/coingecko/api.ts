import { Effect, Schema } from "effect";
import type { Call } from "../../runtime/define";
import type { Requester } from "../../runtime/http";
import { maybe } from "../../runtime/schema";
import {
  type COINGECKO_API_KEY,
  COINGECKO_PRO_API_KEY,
  EXCHANGE_RATES_PATH,
  PRO_HOST,
} from "./constants";

// Response DTOs: only the fields we read. Types derive from the schema, so an upstream shape change
// is an `UpstreamParseError` on the spot.

const Image = Schema.Struct({
  thumb: maybe(Schema.String),
  small: maybe(Schema.String),
  large: maybe(Schema.String),
});

// One item of GET /asset_platforms
export const AssetPlatform = Schema.Struct({
  id: maybe(Schema.String),
  chain_identifier: Schema.optional(Schema.NullOr(Schema.Number)),
  name: maybe(Schema.String),
  image: Schema.optional(Schema.NullOr(Image)),
});
export type AssetPlatform = typeof AssetPlatform.Type;

// One item of GET /coins/list?include_platform=true. `platforms` is keyed by CoinGecko's
// asset_platform id with the contract address as value; native coins have an empty dict.
export const CoinListItem = Schema.Struct({
  id: maybe(Schema.String),
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  platforms: maybe(Schema.Record(Schema.String, Schema.NullOr(Schema.String))),
});
export type CoinListItem = typeof CoinListItem.Type;

// One item of GET /coins/markets (current_price is USD when vs_currency=usd)
export const MarketCoin = Schema.Struct({
  id: maybe(Schema.String),
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  image: maybe(Schema.String),
  current_price: Schema.optional(Schema.NullOr(Schema.Number)),
  market_cap_rank: Schema.optional(Schema.NullOr(Schema.Number)),
  price_change_percentage_24h: Schema.optional(Schema.NullOr(Schema.Number)),
  last_updated: maybe(Schema.String),
});
export type MarketCoin = typeof MarketCoin.Type;

// GET /simple/price: { [coinId]: { usd, usd_24h_change, last_updated_at } }
export const SimplePriceMap = Schema.Record(
  Schema.String,
  Schema.Record(Schema.String, Schema.Number),
);
export type SimplePriceMap = typeof SimplePriceMap.Type;

// GET /coins/{id}/market_chart/range: [msTimestamp, value] pairs (ms, unlike the seconds of the
// from/to params); only prices is read.
const MarketChartRange = Schema.Struct({
  prices: Schema.Array(Schema.Tuple([Schema.Number, Schema.Number])),
});

const SearchCoin = Schema.Struct({
  id: maybe(Schema.String),
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  market_cap_rank: Schema.optional(Schema.NullOr(Schema.Number)),
  large: maybe(Schema.String),
  thumb: maybe(Schema.String),
});

export const SearchResult = Schema.Struct({ coins: maybe(Schema.Array(SearchCoin)) });
export type SearchResult = typeof SearchResult.Type;

// GET /exchange_rates: value = how much of the currency 1 BTC is worth.
const ExchangeRateEntry = Schema.Struct({
  name: maybe(Schema.String),
  unit: maybe(Schema.String),
  value: maybe(Schema.Number),
  type: maybe(Schema.String), // "fiat" | "crypto"
});

const ExchangeRates = Schema.Struct({
  rates: maybe(Schema.Record(Schema.String, ExchangeRateEntry)),
});

export type CoinGeckoCall = Call<never, typeof COINGECKO_API_KEY | typeof COINGECKO_PRO_API_KEY>;

// A pro key is only accepted on the pro domain.
const send = (call: CoinGeckoCall): Requester =>
  call.keys[COINGECKO_PRO_API_KEY] ? call.host(PRO_HOST) : call.request;

export const assetPlatforms = (call: CoinGeckoCall) =>
  send(call)("/asset_platforms", Schema.Array(AssetPlatform));

export const coinsList = (call: CoinGeckoCall) =>
  send(call)("/coins/list", Schema.Array(CoinListItem), { query: { include_platform: "true" } });

export interface CoinsMarketsParams {
  readonly vsCurrency: string;
  readonly ids?: readonly string[];
  readonly order?: string;
  readonly perPage?: number;
  readonly page?: number;
  readonly priceChangePercentage?: string;
}

export const coinsMarkets = (call: CoinGeckoCall, params: CoinsMarketsParams) =>
  send(call)("/coins/markets", Schema.Array(MarketCoin), {
    query: {
      vs_currency: params.vsCurrency,
      ids: params.ids?.join(","),
      order: params.order,
      per_page: params.perPage,
      page: params.page,
      price_change_percentage: params.priceChangePercentage,
    },
  });

export interface SimplePriceParams {
  readonly ids: readonly string[];
  readonly vsCurrencies: readonly string[];
  readonly include24hrChange?: boolean;
  readonly includeLastUpdatedAt?: boolean;
}

export const simplePrice = (call: CoinGeckoCall, params: SimplePriceParams) =>
  send(call)("/simple/price", SimplePriceMap, {
    query: {
      ids: params.ids.join(","),
      vs_currencies: params.vsCurrencies.join(","),
      // Sending "false" and omitting are not the same to CGK.
      include_24hr_change: params.include24hrChange ? "true" : undefined,
      include_last_updated_at: params.includeLastUpdatedAt ? "true" : undefined,
    },
  });

export interface MarketChartRangeParams {
  readonly id: string;
  readonly vsCurrency: string;
  readonly fromSec: number;
  readonly toSec: number;
}

// The wrapper object carries nothing else we read; a missing `prices` is a parse failure.
export const marketChartRange = (call: CoinGeckoCall, params: MarketChartRangeParams) =>
  send(call)(`/coins/${params.id}/market_chart/range`, MarketChartRange, {
    query: { vs_currency: params.vsCurrency, from: params.fromSec, to: params.toSec },
  }).pipe(Effect.map((res) => res.prices));

export const search = (call: CoinGeckoCall, query: string) =>
  send(call)("/search", SearchResult, { query: { query } });

export const exchangeRates = (call: CoinGeckoCall) =>
  send(call)(EXCHANGE_RATES_PATH, ExchangeRates);

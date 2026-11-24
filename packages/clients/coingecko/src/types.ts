import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// CoinGecko response DTOs: only the fields this repo's consumers read (partial). Types derive from the schema, so an upstream
// shape change is an `UpstreamParseError` on the spot.

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

// One item of GET /coins/list?include_platform=true. `platforms`: which chains the token is on, keyed by CoinGecko's asset_platform id with the
// contract address as value; native coins (BTC/ETH/SOL…) have an empty dict.
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

// GET /coins/{id}/market_chart/range: { prices, market_caps, total_volumes }
// Each item is a [msTimestamp, value] pair (timestamp in milliseconds, unlike the seconds of the from/to query params); only prices is consumed.
export const MarketChartRange = Schema.Struct({
  prices: maybe(Schema.Array(Schema.Tuple([Schema.Number, Schema.Number]))),
});
export type MarketChartRange = typeof MarketChartRange.Type;

// One coin of GET /search
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

// GET /coins/{platform}/contract/{addr} (image is an object, unlike markets' string)
export const CoinContract = Schema.Struct({
  id: maybe(Schema.String),
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  image: maybe(Image),
  market_cap_rank: Schema.optional(Schema.NullOr(Schema.Number)),
  market_data: maybe(
    Schema.Struct({
      current_price: maybe(Schema.Record(Schema.String, Schema.Number)),
      price_change_percentage_24h: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  ),
  last_updated: maybe(Schema.String),
});
export type CoinContract = typeof CoinContract.Type;

// GET /exchanges/{id} and GET /derivatives/exchanges/{id} (image is a direct link string)
export const Exchange = Schema.Struct({ name: maybe(Schema.String), image: maybe(Schema.String) });
export type Exchange = typeof Exchange.Type;

export const DerivativesExchange = Schema.Struct({
  name: maybe(Schema.String),
  image: maybe(Schema.String),
});
export type DerivativesExchange = typeof DerivativesExchange.Type;

// GET /exchange_rates: { rates: { <code>: { name, unit, value, type } } }
// value = how much of the currency 1 BTC is worth; type distinguishes fiat / crypto.
const ExchangeRateEntry = Schema.Struct({
  name: maybe(Schema.String),
  unit: maybe(Schema.String),
  value: maybe(Schema.Number),
  type: maybe(Schema.String), // "fiat" | "crypto"
});

export const ExchangeRates = Schema.Struct({
  rates: maybe(Schema.Record(Schema.String, ExchangeRateEntry)),
});
export type ExchangeRates = typeof ExchangeRates.Type;

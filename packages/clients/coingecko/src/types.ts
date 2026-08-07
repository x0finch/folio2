import { maybe } from "@folio/client-core";
import { Schema } from "effect";

// CoinGecko 响应 DTO —— 仅声明本仓消费方实际读取的字段(partial;CGK 响应远比这丰富)。
//
// 字段一个没动 —— 换的是「谁说了算」:以前是 `interface` + 一次 `as`(声明而已,运行时没人查),
// 现在是 schema,类型从它推出来,上游改了形状当场就是 `UpstreamParseError`。

const Image = Schema.Struct({
  thumb: maybe(Schema.String),
  small: maybe(Schema.String),
  large: maybe(Schema.String),
});

// GET /asset_platforms 的一项
export const AssetPlatform = Schema.Struct({
  id: maybe(Schema.String),
  chain_identifier: Schema.optional(Schema.NullOr(Schema.Number)),
  name: maybe(Schema.String),
  image: Schema.optional(Schema.NullOr(Image)),
});
export type AssetPlatform = typeof AssetPlatform.Type;

// GET /coins/list?include_platform=true 的一项。
// `platforms` = 「这个币在哪些链上、地址是什么」:键是 CoinGecko 的 asset_platform id,
// 值是合约地址。原生币(BTC/ETH/SOL…)的字典是空的 —— 它们不在任何链上有合约。
export const CoinListItem = Schema.Struct({
  id: maybe(Schema.String),
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  platforms: maybe(Schema.Record({ key: Schema.String, value: Schema.NullOr(Schema.String) })),
});
export type CoinListItem = typeof CoinListItem.Type;

// GET /coins/markets 的一项(vs_currency=usd 时 current_price 即 USD)
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

// GET /simple/price → { [coinId]: { usd, usd_24h_change, last_updated_at } }
export const SimplePriceMap = Schema.Record({
  key: Schema.String,
  value: Schema.Record({ key: Schema.String, value: Schema.Number }),
});
export type SimplePriceMap = typeof SimplePriceMap.Type;

// GET /coins/{id}/market_chart/range → { prices, market_caps, total_volumes }
// 每项是 [msTimestamp, value] 对(时间戳为**毫秒**,与 from/to 查询参数的秒不同)。仅消费 prices。
export const MarketChartRange = Schema.Struct({
  prices: maybe(Schema.Array(Schema.Tuple(Schema.Number, Schema.Number))),
});
export type MarketChartRange = typeof MarketChartRange.Type;

// GET /search 的一个 coin
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

// GET /coins/{platform}/contract/{addr}(image 是对象,与 markets 的 string 不同)
export const CoinContract = Schema.Struct({
  id: maybe(Schema.String),
  symbol: maybe(Schema.String),
  name: maybe(Schema.String),
  image: maybe(Image),
  market_cap_rank: Schema.optional(Schema.NullOr(Schema.Number)),
  market_data: maybe(
    Schema.Struct({
      current_price: maybe(Schema.Record({ key: Schema.String, value: Schema.Number })),
      price_change_percentage_24h: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  ),
  last_updated: maybe(Schema.String),
});
export type CoinContract = typeof CoinContract.Type;

// GET /exchanges/{id} 与 GET /derivatives/exchanges/{id}(image 为直链字符串)
export const Exchange = Schema.Struct({ name: maybe(Schema.String), image: maybe(Schema.String) });
export type Exchange = typeof Exchange.Type;

export const DerivativesExchange = Schema.Struct({
  name: maybe(Schema.String),
  image: maybe(Schema.String),
});
export type DerivativesExchange = typeof DerivativesExchange.Type;

// GET /exchange_rates → { rates: { <code>: { name, unit, value, type } } }
// value = 每 1 BTC 值多少该币种;type 区分 fiat / crypto。
const ExchangeRateEntry = Schema.Struct({
  name: maybe(Schema.String),
  unit: maybe(Schema.String),
  value: maybe(Schema.Number),
  type: maybe(Schema.String), // "fiat" | "crypto"
});

export const ExchangeRates = Schema.Struct({
  rates: maybe(Schema.Record({ key: Schema.String, value: ExchangeRateEntry })),
});
export type ExchangeRates = typeof ExchangeRates.Type;

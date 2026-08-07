// CoinGecko 响应 DTO —— 仅声明本仓消费方实际读取的字段(partial;CGK 响应远比这丰富)。

// GET /asset_platforms 的一项
export interface AssetPlatform {
  id?: string;
  chain_identifier?: number | null;
  name?: string;
  image?: { thumb?: string; small?: string; large?: string } | null;
}

// GET /coins/list?include_platform=true 的一项。
// `platforms` = 「这个币在哪些链上、地址是什么」:键是 CoinGecko 的 asset_platform id,
// 值是合约地址。原生币(BTC/ETH/SOL…)的字典是空的 —— 它们不在任何链上有合约。
export interface CoinListItem {
  id?: string;
  symbol?: string;
  name?: string;
  platforms?: Record<string, string | null>;
}

// GET /coins/markets 的一项(vs_currency=usd 时 current_price 即 USD)
export interface MarketCoin {
  id?: string;
  symbol?: string;
  name?: string;
  image?: string;
  current_price?: number | null;
  market_cap_rank?: number | null;
  price_change_percentage_24h?: number | null;
  last_updated?: string;
}

// GET /simple/price → { [coinId]: { usd, usd_24h_change, last_updated_at } }
export type SimplePriceMap = Record<string, Record<string, number>>;

// GET /coins/{id}/market_chart/range → { prices, market_caps, total_volumes }
// 每项是 [msTimestamp, value] 对(时间戳为**毫秒**,与 from/to 查询参数的秒不同)。仅消费 prices。
export interface MarketChartRange {
  prices?: [number, number][];
}

// GET /search 的一个 coin
interface SearchCoin {
  id?: string;
  symbol?: string;
  name?: string;
  market_cap_rank?: number | null;
  large?: string;
  thumb?: string;
}
export interface SearchResult {
  coins?: SearchCoin[];
}

// GET /coins/{platform}/contract/{addr}(image 是对象,与 markets 的 string 不同)
export interface CoinContract {
  id?: string;
  symbol?: string;
  name?: string;
  image?: { thumb?: string; small?: string; large?: string };
  market_cap_rank?: number | null;
  market_data?: {
    current_price?: Record<string, number>;
    price_change_percentage_24h?: number | null;
  };
  last_updated?: string;
}

// GET /exchanges/{id} 与 GET /derivatives/exchanges/{id}(image 为直链字符串)
export interface Exchange {
  name?: string;
  image?: string;
}
export interface DerivativesExchange {
  name?: string;
  image?: string;
}

// GET /exchange_rates → { rates: { <code>: { name, unit, value, type } } }
// value = 每 1 BTC 值多少该币种;type 区分 fiat / crypto。
interface ExchangeRateEntry {
  name?: string;
  unit?: string;
  value?: number;
  type?: string; // "fiat" | "crypto"
}
export interface ExchangeRates {
  rates?: Record<string, ExchangeRateEntry>;
}

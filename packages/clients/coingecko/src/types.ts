// CoinGecko 响应 DTO —— 仅声明本仓消费方实际读取的字段(partial;CGK 响应远比这丰富)。

// GET /asset_platforms 的一项
export interface AssetPlatform {
  id?: string;
  chain_identifier?: number | null;
  name?: string;
  image?: { thumb?: string; small?: string; large?: string } | null;
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

// GET /search 的一个 coin
export interface SearchCoin {
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

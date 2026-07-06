// SDK 式 CoinGecko 客户端:一个 endpoint 一个带类型方法。低层 request 内部化(见 http.ts),不外泄。
import { type CoinGeckoConfig, CoinGeckoError, createRequester } from "./http";
import type {
  AssetPlatform,
  CoinContract,
  DerivativesExchange,
  Exchange,
  MarketCoin,
  SearchResult,
  SimplePriceMap,
} from "./types";

export interface CoinsMarketsParams {
  vsCurrency: string;
  order?: string;
  perPage?: number;
  page?: number;
  priceChangePercentage?: string; // 逗号分隔窗口,如 "24h,7d,30d"
}

export interface SimplePriceParams {
  ids: string[];
  vsCurrencies: string[];
  include24hrChange?: boolean;
  includeLastUpdatedAt?: boolean;
}

export interface CoinGeckoClient {
  /** GET /asset_platforms */
  assetPlatforms(): Promise<AssetPlatform[]>;
  /** GET /coins/markets(按市值页取) */
  coinsMarkets(params: CoinsMarketsParams): Promise<MarketCoin[]>;
  /** GET /simple/price(按 coin id 批量取价) */
  simplePrice(params: SimplePriceParams): Promise<SimplePriceMap>;
  /** GET /search(选币 autocomplete) */
  search(query: string): Promise<SearchResult>;
  /** GET /coins/{platform}/contract/{addr};404 → null */
  coinContract(platform: string, address: string): Promise<CoinContract | null>;
  /** GET /exchanges/{id}(CEX);404 → null */
  exchange(id: string): Promise<Exchange | null>;
  /** GET /derivatives/exchanges/{id}(perp);404 → null */
  derivativesExchange(id: string): Promise<DerivativesExchange | null>;
}

export function createCoinGeckoClient(config: CoinGeckoConfig = {}): CoinGeckoClient {
  const request = createRequester(config);

  // 列表端点:顶层守卫为数组,让 DTO 返回类型诚实(非数组 → PARSE_ERROR)。
  const asArray = <T>(json: unknown, ctx: string): T[] => {
    if (!Array.isArray(json)) throw new CoinGeckoError("PARSE_ERROR", `${ctx}: expected array`);
    return json as T[];
  };

  return {
    async assetPlatforms() {
      return asArray<AssetPlatform>(await request("/asset_platforms"), "asset_platforms");
    },

    async coinsMarkets(params) {
      const json = await request("/coins/markets", {
        vs_currency: params.vsCurrency,
        order: params.order,
        per_page: params.perPage,
        page: params.page,
        price_change_percentage: params.priceChangePercentage,
      });
      return asArray<MarketCoin>(json, "coins/markets");
    },

    async simplePrice(params) {
      const json = await request("/simple/price", {
        ids: params.ids.join(","),
        vs_currencies: params.vsCurrencies.join(","),
        include_24hr_change: params.include24hrChange ? "true" : undefined,
        include_last_updated_at: params.includeLastUpdatedAt ? "true" : undefined,
      });
      if (typeof json !== "object" || json === null) {
        throw new CoinGeckoError("PARSE_ERROR", "simple/price: expected object");
      }
      return json as SimplePriceMap;
    },

    async search(query) {
      return (await request("/search", { query })) as SearchResult;
    },

    async coinContract(platform, address) {
      const json = await request(
        `/coins/${platform}/contract/${address.toLowerCase()}`,
        undefined,
        { notFoundAsNull: true },
      );
      return json === null ? null : (json as CoinContract);
    },

    async exchange(id) {
      const json = await request(`/exchanges/${id}`, undefined, { notFoundAsNull: true });
      return json === null ? null : (json as Exchange);
    },

    async derivativesExchange(id) {
      const json = await request(`/derivatives/exchanges/${id}`, undefined, {
        notFoundAsNull: true,
      });
      return json === null ? null : (json as DerivativesExchange);
    },
  };
}

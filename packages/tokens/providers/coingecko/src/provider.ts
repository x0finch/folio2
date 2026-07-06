import {
  type CoinGeckoConfig,
  CoinGeckoError,
  createCoinGeckoClient,
} from "@folio/coingecko-client";
import {
  TokenError,
  type TokenInfo,
  type TokenPrice,
  type TokenProvider,
} from "@folio/tokens-basic";
import {
  EP_ASSET_PLATFORMS,
  EP_COINS,
  EP_COINS_MARKETS,
  EP_SEARCH,
  EP_SIMPLE_PRICE,
  PER_PAGE_MAX,
  PRICE_CHANGE_WINDOWS,
  VS_USD,
} from "./constants";
import {
  parseAssetPlatforms,
  parseContract,
  parseMarkets,
  parseSearch,
  parseSimplePrice,
} from "./parse";

// config 由共享 client 定义;这里 re-export 保持既有对外形状。
export type { CoinGeckoConfig };

// CoinGecko 的 `TokenProvider` 实现。HTTP 走共享 `@folio/coingecko-client`;把 client 的
// `CoinGeckoError` 映射成 token 域的 `TokenError`(错误码 1:1,retryable/retryAfterMs 透传)。
// 通用层只给 `chain`;CGK 的 `platform`(asset_platform slug)是内部细节 —— 闭包 memo 一份表。
export function createCoinGeckoProvider(config: CoinGeckoConfig = {}): TokenProvider {
  const client = createCoinGeckoClient(config);

  const request = async (
    path: string,
    query?: Record<string, string | number>,
    opts?: { notFoundAsNull?: boolean },
  ): Promise<unknown> => {
    try {
      return await client.request(path, query, opts);
    } catch (e) {
      if (e instanceof CoinGeckoError) {
        throw new TokenError(e.code, e.message, {
          retryable: e.retryable,
          retryAfterMs: e.retryAfterMs,
          cause: (e as { cause?: unknown }).cause,
        });
      }
      throw e;
    }
  };

  let platformMap: Map<string, string> | undefined; // chain(slug+chainId) → CGK platform slug,首次按需取

  const platformFor = async (chain: string): Promise<string | undefined> => {
    if (!platformMap) {
      platformMap = parseAssetPlatforms(await request(EP_ASSET_PLATFORMS));
    }
    return platformMap.get(chain.toLowerCase());
  };

  return {
    source: "coingecko",
    async fetchByContract(chain, contract) {
      const platform = await platformFor(chain);
      if (!platform) return null; // chain 未被 CGK 收录
      const path = `${EP_COINS}/${platform}/contract/${contract.toLowerCase()}`;
      const json = await request(path, undefined, { notFoundAsNull: true });
      return json === null ? null : parseContract(json);
    },

    async fetchMarkets(opts) {
      const perPage = Math.min(PER_PAGE_MAX, opts.topN);
      const pages = Math.max(1, Math.ceil(opts.topN / perPage));
      const out: { info: TokenInfo; price: TokenPrice }[] = [];
      for (let page = 1; page <= pages; page++) {
        const json = await request(EP_COINS_MARKETS, {
          vs_currency: VS_USD,
          order: "market_cap_desc",
          per_page: perPage,
          page,
          price_change_percentage: PRICE_CHANGE_WINDOWS,
        });
        const rows = parseMarkets(json);
        out.push(...rows);
        if (rows.length < perPage) break; // 末页(不足一页)→ 停
      }
      return out.slice(0, opts.topN);
    },

    async searchTokens(query) {
      const q = query.trim();
      if (!q) return [];
      return parseSearch(await request(EP_SEARCH, { query: q }));
    },

    async fetchPrices(refs) {
      const ids = refs
        .filter((r) => r.source === "coingecko")
        .map((r) => r.identifier)
        .join(",");
      if (!ids) return new Map();
      const json = await request(EP_SIMPLE_PRICE, {
        ids,
        vs_currencies: VS_USD,
        include_24hr_change: "true",
        include_last_updated_at: "true",
      });
      return parseSimplePrice(json);
    },
  };
}

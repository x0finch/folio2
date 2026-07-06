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
import { PER_PAGE_MAX, PRICE_CHANGE_WINDOWS, VS_USD } from "./constants";
import {
  parseAssetPlatforms,
  parseContract,
  parseMarkets,
  parseSearch,
  parseSimplePrice,
} from "./parse";

// config 由共享 client 定义;这里 re-export 保持既有对外形状。
export type { CoinGeckoConfig };

// CoinGecko 的 `TokenProvider` 实现。HTTP 走共享 `@folio/coingecko-client` 的 SDK 方法;把 client 的
// `CoinGeckoError` 映射成 token 域的 `TokenError`(错误码 1:1,retryable/retryAfterMs 透传)。
// 通用层只给 `chain`;CGK 的 `platform`(asset_platform slug)是内部细节 —— 闭包 memo 一份表。
export function createCoinGeckoProvider(config: CoinGeckoConfig = {}): TokenProvider {
  const client = createCoinGeckoClient(config);

  // 把 client 的 CoinGeckoError 映射成 token 域 TokenError(其余异常透传)。
  const mapErr = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await p;
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
      platformMap = parseAssetPlatforms(await mapErr(client.assetPlatforms()));
    }
    return platformMap.get(chain.toLowerCase());
  };

  return {
    source: "coingecko",
    async fetchByContract(chain, contract) {
      const platform = await platformFor(chain);
      if (!platform) return null; // chain 未被 CGK 收录
      const json = await mapErr(client.coinContract(platform, contract));
      return json === null ? null : parseContract(json);
    },

    async fetchMarkets(opts) {
      const perPage = Math.min(PER_PAGE_MAX, opts.topN);
      const pages = Math.max(1, Math.ceil(opts.topN / perPage));
      const out: { info: TokenInfo; price: TokenPrice }[] = [];
      for (let page = 1; page <= pages; page++) {
        const rows = parseMarkets(
          await mapErr(
            client.coinsMarkets({
              vsCurrency: VS_USD,
              order: "market_cap_desc",
              perPage,
              page,
              priceChangePercentage: PRICE_CHANGE_WINDOWS,
            }),
          ),
        );
        out.push(...rows);
        if (rows.length < perPage) break; // 末页(不足一页)→ 停
      }
      return out.slice(0, opts.topN);
    },

    async searchTokens(query) {
      const q = query.trim();
      if (!q) return [];
      return parseSearch(await mapErr(client.search(q)));
    },

    async fetchPrices(refs) {
      const ids = refs.filter((r) => r.source === "coingecko").map((r) => r.identifier);
      if (ids.length === 0) return new Map();
      const json = await mapErr(
        client.simplePrice({
          ids,
          vsCurrencies: [VS_USD],
          include24hrChange: true,
          includeLastUpdatedAt: true,
        }),
      );
      return parseSimplePrice(json);
    },
  };
}

import { type CoinGeckoConfig, createCoinGeckoClient } from "@folio/coingecko-client";
import type { TokenSource } from "@folio/oracle2";
import { EVM_NAMER_PREFIX, MARKETS_PER_PAGE, SOURCE_ID, VS_USD } from "./constants";
import {
  coinIdOf,
  parseContract,
  parseMarkets,
  parsePriceSeries,
  parseSearch,
  parseSimplePrice,
} from "./parse";
import { toRefIndexRows } from "./ref-index";

export type { CoinGeckoConfig };

// `TokenSource` 三面的 CoinGecko 实现。**全仓只有本包认识 CoinGecko** ——
// 服务层收的是这个接口,由 app 在装配时注入(ADR 0023)。
//
// 通用层只说「我们的 chain 标识」(`evm:<chainId>` / `<slug>`);翻成 CoinGecko 的 asset_platform
// 是本文件的活:EVM 拿数字 chainId 去查平台表(比 slug 更可靠地命中),非 EVM 直接给 slug。
export function createCoinGeckoSource(config: CoinGeckoConfig = {}): TokenSource {
  const client = createCoinGeckoClient(config);
  // 平台表进程内记一次:一次 sync 里可能连着单查几个合约,没必要每次重拉。
  let platformsBySlug: Promise<Map<string, string>> | undefined;

  const chainToPlatform = async (chain: string): Promise<string | undefined> => {
    platformsBySlug ??= client.assetPlatforms().then((list) => {
      const m = new Map<string, string>();
      for (const p of list) {
        if (!p?.id) continue;
        m.set(p.id.toLowerCase(), p.id);
        if (p.chain_identifier != null) m.set(String(p.chain_identifier), p.id);
      }
      return m;
    });
    const key = chain.startsWith(EVM_NAMER_PREFIX)
      ? chain.slice(EVM_NAMER_PREFIX.length)
      : chain.toLowerCase();
    return (await platformsBySlug).get(key);
  };

  return {
    id: SOURCE_ID,

    async fetchMarkets({ topN }) {
      const pages = Math.max(1, Math.ceil(topN / MARKETS_PER_PAGE));
      const out = [];
      for (let page = 1; page <= pages; page++) {
        const rows = await client.coinsMarkets({
          vsCurrency: VS_USD,
          order: "market_cap_desc",
          perPage: MARKETS_PER_PAGE,
          page,
          priceChangePercentage: "24h",
        });
        out.push(...parseMarkets(rows));
        if (rows.length < MARKETS_PER_PAGE) break; // 上游没那么多币了
      }
      return out.slice(0, topN);
    },

    async searchTokens(query) {
      return parseSearch(await client.search(query));
    },

    async fetchPrices(refs) {
      const ids = refs.map(coinIdOf).filter((id): id is string => id != null);
      if (ids.length === 0) return new Map();
      const json = await client.simplePrice({
        ids,
        vsCurrencies: [VS_USD],
        include24hrChange: true,
        includeLastUpdatedAt: true,
      });
      return parseSimplePrice(json, Date.now());
    },

    async fetchPriceSeries(ref, fromMs, toMs) {
      const id = coinIdOf(ref);
      if (!id) return []; // 不是本源命名的 ref → 本源给不出历史价
      const pairs = await client.coinsMarketChartRange({
        id,
        vsCurrency: VS_USD,
        fromSec: Math.floor(fromMs / 1000),
        toSec: Math.ceil(toMs / 1000),
      });
      return parsePriceSeries(pairs);
    },

    async fetchByContract(chain, contract) {
      const platform = await chainToPlatform(chain);
      if (!platform) return null; // 这条链 CoinGecko 没收录
      return parseContract(await client.coinContract(platform, contract));
    },

    async fetchRefIndex() {
      // 两个端点各一次:整份币目录(含各链合约地址)+ 平台表(拿 chain_identifier)。
      const [coins, platforms] = await Promise.all([client.coinsList(), client.assetPlatforms()]);
      return toRefIndexRows(coins, platforms);
    },
  };
}

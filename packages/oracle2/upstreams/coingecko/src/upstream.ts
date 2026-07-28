import { type CoinGeckoConfig, createCoinGeckoClient } from "@folio/coingecko-client";
import type { TokenUpstream } from "@folio/oracle2-basic";
import { EVM_NAMER_PREFIX, MARKETS_PER_PAGE, UPSTREAM_ID, VS_USD } from "./constants";
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

// `TokenUpstream` 三面的 CoinGecko 实现。**全仓只有本包认识 CoinGecko** ——
// 服务层收的是这个接口,由 app 在装配时注入(ADR 0023)。
//
// 通用层只说「我们的 chain 标识」(`evm:<chainId>` / `<slug>`);翻成 CoinGecko 的 asset_platform
// 是本文件的活:EVM 拿数字 chainId 去查平台表(比 slug 更可靠地命中),非 EVM 直接给 slug。
export function createCoinGeckoUpstream(config: CoinGeckoConfig = {}): TokenUpstream {
  const client = createCoinGeckoClient(config);
  // 平台表进程内记一次:一次 sync 里可能连着单查几个合约,没必要每次重拉。
  let platformsBySlug: Promise<Map<string, string>> | undefined;

  const chainToPlatform = async (chain: string): Promise<string | undefined> => {
    // **失败不进记忆。** 裸 `??=` 会把被拒绝的 promise 也记住:Workers 的 isolate 跨请求存活,
    // 一次瞬时 429 就让本 isolate 余生所有 fetchByContract 直接失败 —— 而且是静默的
    // (上层 SWR 把抛错当「上游没有」吞掉)。故先清槽再抛,下一次调用重新拉。
    platformsBySlug ??= client
      .assetPlatforms()
      .then((list) => {
        const m = new Map<string, string>();
        for (const p of list) {
          if (!p?.id) continue;
          m.set(p.id.toLowerCase(), p.id);
          if (p.chain_identifier != null) m.set(String(p.chain_identifier), p.id);
        }
        return m;
      })
      .catch((err) => {
        platformsBySlug = undefined;
        throw err;
      });
    const key = chain.startsWith(EVM_NAMER_PREFIX)
      ? chain.slice(EVM_NAMER_PREFIX.length)
      : chain.toLowerCase();
    return (await platformsBySlug).get(key);
  };

  return {
    id: UPSTREAM_ID,

    // **翻页要去重 —— 同一个币会在两页里各出现一次。**
    //
    // CoinGecko 的这几页不是同一份榜单切出来的:一次四页的抓取里,第 1、2 页盖着同一个
    // `last_updated`,第 3 页每条都更新。而排序按市值,某些币的流通量在两份数据之间被修正过
    // (实测 collector-crypt 同一个 rank、几乎同一个价,市值 $251M vs $32M),于是它在旧那份里
    // 排进第 1 页、在新那份里又排进第 3 页。实测 1000 条里 43 个币重复,且**没有一个**两次市值相同。
    //
    // 不去重的后果不止是列表里多几行:按 symbol 认币时,重复的币会变成**自己跟自己比**,
    // 永远碾压不了「次席」,于是判定为没把握 —— 那个币从此认不出来,而且一声不吭
    // (见 entry 的 `candidatesBySymbol` / `pickByConfidence`)。
    //
    // **去重之后拿到的会少于 topN**(43 个重复 = 43 个空位),这是明知接受的:补齐要多翻页,
    // 而多翻的那页同样会撞重复,补不出保证;少的那几十个又都在榜尾最不稳的一段。
    // 所以 `topN` 的意思是「往下抓多深」,不是「保证拿到这么多个币」。
    async fetchMarkets({ topN }) {
      const pages = Math.max(1, Math.ceil(topN / MARKETS_PER_PAGE));
      const out = [];
      const seen = new Set<string>();
      for (let page = 1; page <= pages; page++) {
        const rows = await client.coinsMarkets({
          vsCurrency: VS_USD,
          order: "market_cap_desc",
          perPage: MARKETS_PER_PAGE,
          page,
          priceChangePercentage: "24h",
        });
        for (const token of parseMarkets(rows)) {
          if (seen.has(token.ref)) continue; // 先出现的那条胜出(它排得更靠前)
          seen.add(token.ref);
          out.push(token);
        }
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

    // 按 id 点查一批整行。走 `/coins/markets?ids=…` 而不是 `/simple/price`:后者只回价,
    // 而这里要的正是 name/symbol/image。同一个端点、同一个解析器,只是不翻页。
    async fetchTokens(refs) {
      const ids = refs.map(coinIdOf).filter((id): id is string => id != null);
      if (ids.length === 0) return [];
      const rows = await client.coinsMarkets({
        vsCurrency: VS_USD,
        ids,
        perPage: MARKETS_PER_PAGE,
        priceChangePercentage: "24h",
      });
      return parseMarkets(rows);
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

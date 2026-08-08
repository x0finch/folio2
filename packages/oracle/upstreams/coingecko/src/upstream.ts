import type { UpstreamError } from "@folio/client-core";
import type { CoinGeckoConfig } from "@folio/coingecko-client";
import type {
  RefIndexFetch,
  TokenPrice,
  TokenPricePoint,
  TokenRef,
  UpstreamToken,
} from "@folio/oracle-basic";
import { TokenUpstream } from "@folio/oracle-basic/ports";
import { Clock, Effect, Layer } from "effect";
import { IDS_PER_REQUEST, MARKETS_PER_PAGE, UPSTREAM_ID, VS_USD } from "./constants";
import { closeOver, type Needs, transport } from "./layer";
import { coinIdOf, parseMarkets, parsePriceSeries, parseSearch, parseSimplePrice } from "./parse";
import { toRefIndexRows } from "./ref-index";
import { req, withClient } from "./runtime";

export type { CoinGeckoConfig };

// id 列表切成每片 ≤ size(避免 GET 的 ids 串把 URL 撑爆 → 414,见 constants.IDS_PER_REQUEST)。
function chunk<T>(arr: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// `TokenUpstream` 三面的 CoinGecko 实现,**实现面**(`R` 里带着 client 与 `HttpClient`)。
// 下面的 layer 把它收成端口形状(`R = never`,见 layer.ts 那两条)。
//
// 单独导出是为了测试:测这一层不必经任何包装,假出网、假时钟、限频档都能 provide
// (以前那些测试靠一个全局的「限频旁路」开关,那是 `@folio/shared` 留下的最后一个全局可变状态)。
//
// **`fetchByContract` 连带那张平台表记忆一起删了**(#362 第 4 站):它是「全局映射表里没有的币
// 走单查兜底」那条设计,但**一个调用方都没有** —— 端口上挂着、实现写着、还带一个模块级的
// 可变 memo 和一段解释它为什么难写对的注释。真要这条兜底,重新加一个有调用方的版本比养着它便宜。
export function makeUpstreamEffects() {
  return {
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
    //
    // **保持顺序翻页,不要改成并发**:并发发出去闸也是一个个放行,快不起来,只是把突发额度
    // 更快地抽干、让前台(搜索、选币下拉)等得更久。
    fetchMarkets: ({
      topN,
    }: {
      topN: number;
    }): Effect.Effect<UpstreamToken[], UpstreamError, Needs> =>
      withClient((client) =>
        Effect.gen(function* () {
          const pages = Math.max(1, Math.ceil(topN / MARKETS_PER_PAGE));
          const out: UpstreamToken[] = [];
          const seen = new Set<string>();
          for (let page = 1; page <= pages; page++) {
            const rows = yield* req(
              client.coinsMarkets({
                vsCurrency: VS_USD,
                order: "market_cap_desc",
                perPage: MARKETS_PER_PAGE,
                page,
                priceChangePercentage: "24h",
              }),
            );
            for (const token of parseMarkets(rows)) {
              if (seen.has(token.ref)) continue; // 先出现的那条胜出(它排得更靠前)
              seen.add(token.ref);
              out.push(token);
            }
            if (rows.length < MARKETS_PER_PAGE) break; // 上游没那么多币了
          }
          return out.slice(0, topN);
        }),
      ),

    searchTokens: (query: string): Effect.Effect<UpstreamToken[], UpstreamError, Needs> =>
      withClient((client) => Effect.map(req(client.search(query)), parseSearch)),

    // **id 必须分块**:全塞进一条 GET 的 `ids=` → URL 过长 → CoinGecko 414,整批失败
    // (#245)。按 IDS_PER_REQUEST 切片、逐批取、合并成一个 Map。
    fetchPrices: (
      refs: readonly TokenRef[],
    ): Effect.Effect<Map<TokenRef, TokenPrice>, UpstreamError, Needs> =>
      withClient((client) =>
        Effect.gen(function* () {
          const ids = refs.map(coinIdOf).filter((id): id is string => id != null);
          if (ids.length === 0) return new Map<TokenRef, TokenPrice>();
          const now = yield* Clock.currentTimeMillis;
          const merged = new Map<TokenRef, TokenPrice>();
          for (const batch of chunk(ids, IDS_PER_REQUEST)) {
            const json = yield* req(
              client.simplePrice({
                ids: batch,
                vsCurrencies: [VS_USD],
                include24hrChange: true,
                includeLastUpdatedAt: true,
              }),
            );
            for (const [ref, price] of parseSimplePrice(json, now)) merged.set(ref, price);
          }
          return merged;
        }),
      ),

    // 按 id 点查一批整行。走 `/coins/markets?ids=…` 而不是 `/simple/price`:后者只回价,
    // 而这里要的正是 name/symbol/image。同一个端点、同一个解析器,只是不翻页。
    // 同样**必须分块**(#245):每批 ≤ IDS_PER_REQUEST ≤ MARKETS_PER_PAGE,故一批一页装得下。
    fetchTokens: (
      refs: readonly TokenRef[],
    ): Effect.Effect<UpstreamToken[], UpstreamError, Needs> =>
      withClient((client) =>
        Effect.gen(function* () {
          const ids = refs.map(coinIdOf).filter((id): id is string => id != null);
          if (ids.length === 0) return [];
          const out: UpstreamToken[] = [];
          for (const batch of chunk(ids, IDS_PER_REQUEST)) {
            const rows = yield* req(
              client.coinsMarkets({
                vsCurrency: VS_USD,
                ids: batch,
                perPage: MARKETS_PER_PAGE,
                priceChangePercentage: "24h",
              }),
            );
            out.push(...parseMarkets(rows));
          }
          return out;
        }),
      ),

    // vsCurrency 缺省 USD;法币历史汇率反算取「BTC 在某法币下的历史价」时传 `<code>`(ADR 0026)。
    // 上游要小写(usd / eur)。
    fetchPriceSeries: (
      ref: TokenRef,
      fromMs: number,
      toMs: number,
      vsCurrency: string = VS_USD,
    ): Effect.Effect<TokenPricePoint[], UpstreamError, Needs> =>
      Effect.suspend(() => {
        const id = coinIdOf(ref);
        if (!id) return Effect.succeed([]); // 不是本源命名的 ref → 本源给不出历史价
        return withClient((client) =>
          Effect.map(
            req(
              client.coinsMarketChartRange({
                id,
                vsCurrency: vsCurrency.trim().toLowerCase(),
                fromSec: Math.floor(fromMs / 1000),
                toSec: Math.ceil(toMs / 1000),
              }),
            ),
            parsePriceSeries,
          ),
        );
      }),

    // 两个端点各一次:整份币目录(含各链合约地址)+ 平台表(拿 chain_identifier)。
    fetchRefIndex: (): Effect.Effect<RefIndexFetch, UpstreamError, Needs> =>
      withClient((client) =>
        Effect.map(
          Effect.all([req(client.coinsList), req(client.assetPlatforms)], { concurrency: 2 }),
          ([coins, platformList]) => toRefIndexRows(coins, platformList),
        ),
      ),
  };
}

// 端口。**这里只有接线,没有逻辑** —— 逻辑全在上面那个实现面,这一层只是把每个方法的
// `R`(client + HttpClient)在装配时关掉。
const make = Effect.map(closeOver, (close): TokenUpstream => {
  const impl = makeUpstreamEffects();
  return {
    id: UPSTREAM_ID,
    fetchMarkets: (opts) => close(impl.fetchMarkets(opts)),
    searchTokens: (query) => close(impl.searchTokens(query)),
    fetchPrices: (refs) => close(impl.fetchPrices(refs)),
    fetchTokens: (refs) => close(impl.fetchTokens(refs)),
    fetchPriceSeries: (ref, fromMs, toMs, vsCurrency) =>
      close(impl.fetchPriceSeries(ref, fromMs, toMs, vsCurrency)),
    fetchRefIndex: () => close(impl.fetchRefIndex()),
  };
});

export const coinGeckoTokenUpstreamLayer = (
  config: CoinGeckoConfig = {},
): Layer.Layer<TokenUpstream> =>
  Layer.provide(Layer.effect(TokenUpstream, make), transport(config));

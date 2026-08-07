import {
  makeRateLimit,
  makeRequester,
  type Outbound,
  type Requester,
  type RequestOptions,
  type UpstreamError,
  UpstreamParseError,
} from "@folio/client-core";
import { Context, Duration, Effect, Layer, type Scope } from "effect";
import {
  CG_BASE_FREE,
  CG_BASE_PRO,
  CG_BURST,
  CG_CALLS_PER_MIN_DEMO,
  CG_CALLS_PER_MIN_KEYLESS,
  CG_CALLS_PER_MIN_PRO,
  CG_LIMIT_KEY,
  CG_LIMIT_KEY_KEYLESS,
  HEADER_DEMO,
  HEADER_PRO,
  UPSTREAM,
  USER_AGENT,
} from "./constants";
import type {
  AssetPlatform,
  CoinContract,
  CoinListItem,
  DerivativesExchange,
  Exchange,
  ExchangeRates,
  MarketChartRange,
  MarketCoin,
  SearchResult,
  SimplePriceMap,
} from "./types";

export interface CoinGeckoConfig {
  // 有 key 就带上,并按档位选 base 与额度。**没有 key 也能跑**(keyless 档,按出口 IP 计额)。
  readonly apiKey?: string;
  readonly pro?: boolean;
  readonly baseUrl?: string;
}

export interface CoinsMarketsParams {
  readonly vsCurrency: string;
  readonly ids?: readonly string[];
  readonly order?: string;
  readonly perPage?: number;
  readonly page?: number;
  readonly priceChangePercentage?: string;
}

export interface SimplePriceParams {
  readonly ids: readonly string[];
  readonly vsCurrencies: readonly string[];
  readonly include24hrChange?: boolean;
  readonly includeLastUpdatedAt?: boolean;
}

export interface CoinsMarketChartRangeParams {
  readonly id: string;
  readonly vsCurrency: string;
  readonly fromSec: number;
  readonly toSec: number;
}

// CoinGecko v3 的请求层。**一个端点一个带类型的方法,吐上游形状(DTO)** ——
// 认币、估值 policy、ref 索引那些全在 oracle 那边(ADR 0036)。
//
// **不自带重试**(与另外七个 client 一致):重试由调用方 `Effect.retry(策略)` 加在外面。
// 老那版把重试收进传输层,于是这个仓库对「怎么重试」有过三份答案。
export interface CoinGeckoClientApi {
  readonly assetPlatforms: Effect.Effect<AssetPlatform[], UpstreamError, Outbound>;
  readonly coinsList: Effect.Effect<CoinListItem[], UpstreamError, Outbound>;
  readonly coinsMarkets: (
    params: CoinsMarketsParams,
  ) => Effect.Effect<MarketCoin[], UpstreamError, Outbound>;
  readonly simplePrice: (
    params: SimplePriceParams,
  ) => Effect.Effect<SimplePriceMap, UpstreamError, Outbound>;
  // 历史日价序列。出口就是 `prices` 那一列 —— 上游把它包在一个对象里,那层包装没有信息。
  readonly coinsMarketChartRange: (
    params: CoinsMarketChartRangeParams,
  ) => Effect.Effect<[number, number][], UpstreamError, Outbound>;
  readonly search: (query: string) => Effect.Effect<SearchResult, UpstreamError, Outbound>;
  // 按合约查币。**查不到是正常答案**(不是每个合约都在 CGK 的库里)→ null,不是失败。
  readonly coinContract: (
    platform: string,
    address: string,
  ) => Effect.Effect<CoinContract | null, UpstreamError, Outbound>;
  readonly exchange: (id: string) => Effect.Effect<Exchange | null, UpstreamError, Outbound>;
  readonly derivativesExchange: (
    id: string,
  ) => Effect.Effect<DerivativesExchange | null, UpstreamError, Outbound>;
  readonly exchangeRates: Effect.Effect<ExchangeRates, UpstreamError, Outbound>;
}

export class CoinGeckoClient extends Context.Tag("clients/CoinGecko")<
  CoinGeckoClient,
  CoinGeckoClientApi
>() {
  static readonly layer = (config: CoinGeckoConfig = {}): Layer.Layer<CoinGeckoClient> =>
    Layer.scoped(CoinGeckoClient, make(config));
}

export function make(
  config: CoinGeckoConfig = {},
): Effect.Effect<CoinGeckoClientApi, never, Scope.Scope> {
  return Effect.gen(function* () {
    const callsPerMin = config.pro
      ? CG_CALLS_PER_MIN_PRO
      : config.apiKey
        ? CG_CALLS_PER_MIN_DEMO
        : CG_CALLS_PER_MIN_KEYLESS;

    // **为什么 CGK 最需要闸**:一把 key 全部署共用,所有用户的每次调用都花同一份额度
    // (目录预热 4 页、建 ref 索引时并发两发、搜索、按需取价、历史序列)。跟「每账户各花自己的」
    // 正好相反。
    //
    // **闸的 key 随有没有 key 而变** —— 有 key 是按 key 计额,没 key 是按出口 IP 计额,
    // 那是**两份不同的额度**,不该排在同一个队里。
    const limit = yield* makeRateLimit({
      key: config.apiKey ? CG_LIMIT_KEY : CG_LIMIT_KEY_KEYLESS,
      limit: CG_BURST,
      // 每 interval 放 CG_BURST 发 —— 换算成上游那个「每分钟多少次」的口径。
      interval: Duration.millis((CG_BURST / (callsPerMin / 60)) * 1000),
    });

    const headers: Record<string, string> = {
      accept: "application/json",
      // UA 必须发:Workers 的 fetch 默认不带,而 CGK 的 Cloudflare WAF 对无 UA 请求返 403。
      "user-agent": USER_AGENT,
    };
    if (config.apiKey) headers[config.pro ? HEADER_PRO : HEADER_DEMO] = config.apiKey;

    const request: Requester = makeRequester({
      baseUrl: config.baseUrl ?? (config.pro ? CG_BASE_PRO : CG_BASE_FREE),
      upstream: UPSTREAM,
      limit,
      headers: () => Effect.succeed(headers),
    });

    const parseFailed = (where: string, expected: string) =>
      new UpstreamParseError({ upstream: UPSTREAM, where, cause: `expected ${expected}` });

    // 顶层形状守卫。**留在 client 而不是交给调用方**:「这个端点回的是不是一个数组」是
    // 「读懂上游怎么说话」,不是业务判断;而且没有它,返回类型就是在撒谎。
    //
    // 这不是完整校验(字段一个没查)—— 完整校验是 `Effect.Schema` 那一步的事(ADR 0035 推迟到
    // connectors)。这里只挡住最常见、最难查的那一种:上游改了形状或回了个错误页,
    // 而下游拿着它当数组遍历。
    const expectArray = <T>(path: string, options?: RequestOptions) =>
      request<unknown>(path, options).pipe(
        Effect.flatMap((json) =>
          Array.isArray(json)
            ? Effect.succeed(json as T[])
            : Effect.fail(parseFailed(path, "array")),
        ),
      );

    const expectObject = <T>(path: string, options?: RequestOptions) =>
      request<unknown>(path, options).pipe(
        Effect.flatMap((json) =>
          typeof json === "object" && json !== null
            ? Effect.succeed(json as T)
            : Effect.fail(parseFailed(path, "object")),
        ),
      );

    return {
      assetPlatforms: expectArray<AssetPlatform>("/asset_platforms"),

      coinsList: expectArray<CoinListItem>("/coins/list", {
        query: { include_platform: "true" },
      }),

      coinsMarkets: (params) =>
        expectArray<MarketCoin>("/coins/markets", {
          query: {
            vs_currency: params.vsCurrency,
            ids: params.ids?.join(","),
            order: params.order,
            per_page: params.perPage,
            page: params.page,
            price_change_percentage: params.priceChangePercentage,
          },
        }),

      simplePrice: (params) =>
        expectObject<SimplePriceMap>("/simple/price", {
          query: {
            ids: params.ids.join(","),
            vs_currencies: params.vsCurrencies.join(","),
            // **`undefined` 的键不参与** —— 传 "false" 与不传对 CGK 不是一回事。
            include_24hr_change: params.include24hrChange ? "true" : undefined,
            include_last_updated_at: params.includeLastUpdatedAt ? "true" : undefined,
          },
        }),

      coinsMarketChartRange: (params) =>
        request<unknown>(`/coins/${params.id}/market_chart/range`, {
          query: { vs_currency: params.vsCurrency, from: params.fromSec, to: params.toSec },
        }).pipe(
          Effect.flatMap((json) => {
            const prices = (json as MarketChartRange | null)?.prices;
            return Array.isArray(prices)
              ? Effect.succeed(prices as [number, number][])
              : Effect.fail(parseFailed("/coins/market_chart/range", "{ prices: [] }"));
          }),
        ),

      search: (query) => request<SearchResult>("/search", { query: { query } }),

      coinContract: (platform, address) =>
        request<CoinContract | null>(
          `/coins/${platform}/contract/${address.toLowerCase()}`,
          // 查不到 → null。不是每个合约都在 CGK 的库里,那是正常答案不是故障。
          { notFoundAsNull: true },
        ),

      exchange: (id) => request<Exchange | null>(`/exchanges/${id}`, { notFoundAsNull: true }),

      derivativesExchange: (id) =>
        request<DerivativesExchange | null>(`/derivatives/exchanges/${id}`, {
          notFoundAsNull: true,
        }),

      exchangeRates: expectObject<ExchangeRates>("/exchange_rates"),
    };
  });
}

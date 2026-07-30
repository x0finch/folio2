// SDK 式 CoinGecko 客户端:一个 endpoint 一个带类型方法。传输层是共享的 `createHttpClient`
// (@folio/shared:限频 + 重试 + 失败归类),所以这里只剩「哪个端点收什么参数、回什么形状」。
//
// 两处 CF Workers 修复留在这儿(它们是 CGK 特有的,不是通用行为):
//   ① 注入 User-Agent —— CGK 的 Cloudflare WAF 对无 UA 请求返 403(Workers fetch 默认不带 UA)。
//   ② 直接用全局 `fetch`(包装器内部就是这么做的,不存成方法/this,避免 illegal invocation)。
import { createHttpClient, defineRateLimit, type Fetcher } from "@folio/shared";
import {
  CG_BASE_FREE,
  CG_BASE_PRO,
  CG_BURST,
  CG_CALLS_PER_MIN_DEMO,
  CG_CALLS_PER_MIN_KEYLESS,
  CG_CALLS_PER_MIN_PRO,
  CG_LIMIT_KEY,
  CG_LIMIT_KEY_KEYLESS,
  CG_RETRY_ATTEMPTS,
  CG_RETRY_BASE_MS,
  CG_RETRY_MAX_WAIT_MS,
  HEADER_DEMO,
  HEADER_PRO,
  USER_AGENT,
} from "./constants";
import type {
  AssetPlatform,
  CoinContract,
  CoinGeckoConfig,
  CoinListItem,
  DerivativesExchange,
  Exchange,
  ExchangeRates,
  MarketChartRange,
  MarketCoin,
  SearchResult,
  SimplePriceMap,
} from "./types";

export interface CoinsMarketsParams {
  vsCurrency: string;
  // 指名要哪些币。给了它就不是「按市值翻页」而是「按 id 点查一批」——同一个端点两种用法,
  // 差别只在这个参数。点查要用它而不是 `/simple/price`:后者只回价,不回 name/symbol/image。
  ids?: string[];
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

export interface CoinsMarketChartRangeParams {
  id: string;
  vsCurrency: string;
  fromSec: number; // UNIX 秒(查询参数)
  toSec: number; // UNIX 秒(查询参数)
}

export interface CoinGeckoClient {
  /** GET /asset_platforms */
  assetPlatforms(): Promise<AssetPlatform[]>;
  /** GET /coins/list?include_platform=true(整份币目录 + 各链合约地址;几 MB,只在 cron 里拉) */
  coinsList(): Promise<CoinListItem[]>;
  /** GET /coins/markets(按市值页取) */
  coinsMarkets(params: CoinsMarketsParams): Promise<MarketCoin[]>;
  /** GET /simple/price(按 coin id 批量取价) */
  simplePrice(params: SimplePriceParams): Promise<SimplePriceMap>;
  /** GET /coins/{id}/market_chart/range(一 coin 一区间历史价);返回 prices 对 [msTimestamp, price] */
  coinsMarketChartRange(params: CoinsMarketChartRangeParams): Promise<[number, number][]>;
  /** GET /search(选币 autocomplete) */
  search(query: string): Promise<SearchResult>;
  /** GET /coins/{platform}/contract/{addr};404 → null */
  coinContract(platform: string, address: string): Promise<CoinContract | null>;
  /** GET /exchanges/{id}(CEX);404 → null */
  exchange(id: string): Promise<Exchange | null>;
  /** GET /derivatives/exchanges/{id}(perp);404 → null */
  derivativesExchange(id: string): Promise<DerivativesExchange | null>;
  /** GET /exchange_rates(以 BTC 为基准的全币种汇率) */
  exchangeRates(): Promise<ExchangeRates>;
}

// —— 错误 ——
// 传输层的失败归类由 @folio/shared 做,这里只负责「变成 CGK 自己的错误类型」——
// 调用方(oracle / oracle)只认识它。字段名与仓库里另外三个错误类一致,于是 withRetry 认得。
export type CoinGeckoErrorCode = "RATE_LIMITED" | "UPSTREAM_ERROR" | "PARSE_ERROR";

export class CoinGeckoError extends Error {
  readonly code: CoinGeckoErrorCode;
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(
    code: CoinGeckoErrorCode,
    message: string,
    opts?: { retryable?: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, opts?.cause !== undefined ? { cause: opts.cause } : undefined);
    this.name = "CoinGeckoError";
    this.code = code;
    this.retryable = opts?.retryable ?? code === "RATE_LIMITED";
    this.retryAfterMs = opts?.retryAfterMs;
  }
}

// —— 传输装配 ——
// 为什么 CGK 最需要闸:一把 key 全部署共用,所有用户的每次调用都花同一份额度(目录预热 4 页、
// 建 ref 索引时 Promise.all 两发、搜索、按需取价、历史序列)。跟「每账户各花自己的」正好相反。
function transportFor(config: CoinGeckoConfig): Fetcher {
  const callsPerMin = config.pro
    ? CG_CALLS_PER_MIN_PRO
    : config.apiKey
      ? CG_CALLS_PER_MIN_DEMO
      : CG_CALLS_PER_MIN_KEYLESS;

  const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
  if (config.apiKey) headers[config.pro ? HEADER_PRO : HEADER_DEMO] = config.apiKey;

  return createHttpClient({
    baseUrl: config.baseUrl ?? (config.pro ? CG_BASE_PRO : CG_BASE_FREE),
    headers: () => headers,
    limit: defineRateLimit({
      key: config.apiKey ? CG_LIMIT_KEY : CG_LIMIT_KEY_KEYLESS,
      limit: CG_BURST,
      // 每 interval 放 CG_BURST 发 —— 换算成上游那个「每分钟多少次」的口径。
      interval: (CG_BURST / (callsPerMin / 60)) * 1000,
      sleep: config.sleep,
    }),
    retry: {
      attempts: CG_RETRY_ATTEMPTS,
      maxWaitMs: CG_RETRY_MAX_WAIT_MS,
      baseMs: CG_RETRY_BASE_MS,
      sleep: config.sleep,
      // exceedsMaxWait 用默认的 "throw":这条路可能挂在用户的写路径上(见 constants.ts)。
    },
    toFailure: ({ kind, where, status, retryAfterMs, cause }) => {
      if (kind === "network")
        return new CoinGeckoError("UPSTREAM_ERROR", `coingecko network error: ${where}`, {
          retryable: true,
          cause,
        });
      if (kind === "rate-limited")
        return new CoinGeckoError("RATE_LIMITED", `coingecko rate limited: ${where}`, {
          retryAfterMs,
        });
      if (kind === "parse")
        return new CoinGeckoError("PARSE_ERROR", `coingecko bad json: ${where}`, { cause });
      // auth 也归 UPSTREAM_ERROR:CGK 没有「凭据被拒」这条独立语义,401/403 就是 key 不对或超配额。
      return new CoinGeckoError("UPSTREAM_ERROR", `coingecko ${status} on ${where}`, {
        retryable: (status ?? 0) >= 500,
      });
    },
  });
}

export function createCoinGeckoClient(config: CoinGeckoConfig = {}): CoinGeckoClient {
  const request = transportFor(config);

  // 列表端点:顶层守卫为数组,让 DTO 返回类型诚实(非数组 → PARSE_ERROR)。
  const asArray = <T>(json: unknown, ctx: string): T[] => {
    if (!Array.isArray(json)) throw new CoinGeckoError("PARSE_ERROR", `${ctx}: expected array`);
    return json as T[];
  };

  return {
    async assetPlatforms() {
      return asArray<AssetPlatform>(await request("/asset_platforms"), "asset_platforms");
    },

    async coinsList() {
      const json = await request("/coins/list", { query: { include_platform: "true" } });
      return asArray<CoinListItem>(json, "coins/list");
    },

    async coinsMarkets(params) {
      const json = await request("/coins/markets", {
        query: {
          vs_currency: params.vsCurrency,
          ids: params.ids?.join(","),
          order: params.order,
          per_page: params.perPage,
          page: params.page,
          price_change_percentage: params.priceChangePercentage,
        },
      });
      return asArray<MarketCoin>(json, "coins/markets");
    },

    async simplePrice(params) {
      const json = await request("/simple/price", {
        query: {
          ids: params.ids.join(","),
          vs_currencies: params.vsCurrencies.join(","),
          include_24hr_change: params.include24hrChange ? "true" : undefined,
          include_last_updated_at: params.includeLastUpdatedAt ? "true" : undefined,
        },
      });
      if (typeof json !== "object" || json === null) {
        throw new CoinGeckoError("PARSE_ERROR", "simple/price: expected object");
      }
      return json as SimplePriceMap;
    },

    async coinsMarketChartRange(params) {
      const json = await request(`/coins/${params.id}/market_chart/range`, {
        query: { vs_currency: params.vsCurrency, from: params.fromSec, to: params.toSec },
      });
      if (
        typeof json !== "object" ||
        json === null ||
        !Array.isArray((json as MarketChartRange).prices)
      ) {
        throw new CoinGeckoError(
          "PARSE_ERROR",
          "coins/market_chart/range: expected { prices: [] }",
        );
      }
      return (json as MarketChartRange).prices as [number, number][];
    },

    async search(query) {
      return (await request("/search", { query: { query } })) as SearchResult;
    },

    async coinContract(platform, address) {
      const json = await request(`/coins/${platform}/contract/${address.toLowerCase()}`, {
        notFoundAsNull: true,
      });
      return json === null ? null : (json as CoinContract);
    },

    async exchange(id) {
      const json = await request(`/exchanges/${id}`, { notFoundAsNull: true });
      return json === null ? null : (json as Exchange);
    },

    async derivativesExchange(id) {
      const json = await request(`/derivatives/exchanges/${id}`, { notFoundAsNull: true });
      return json === null ? null : (json as DerivativesExchange);
    },

    async exchangeRates() {
      const json = await request("/exchange_rates");
      if (typeof json !== "object" || json === null) {
        throw new CoinGeckoError("PARSE_ERROR", "exchange_rates: expected object");
      }
      return json as ExchangeRates;
    },
  };
}

import {
  type Fiat,
  TokenError,
  type TokenIndex,
  type TokenInfo,
  type TokenPrice,
  type TokenRef,
  type TokenSource,
} from "@folio/tokens";
import {
  CG_BASE_FREE,
  CG_BASE_PRO,
  EP_ASSET_PLATFORMS,
  EP_COINS_LIST,
  EP_COINS_MARKETS,
  EP_SIMPLE_PRICE,
  HEADER_DEMO,
  HEADER_PRO,
  PER_PAGE_MAX,
  PRICE_CHANGE_WINDOWS,
} from "./constants";
import { buildIndex, parseMarkets, parseRetryAfter, parseSimplePrice } from "./parse";

export interface CoinGeckoConfig {
  apiKey?: string;
  pro?: boolean; // pro key → pro 基址 + pro 头;否则 demo 头 + free 基址
  baseUrl?: string; // 覆盖基址(测试/自托管代理)
  fetchImpl?: typeof fetch; // 注入便于测试
}

// CoinGecko 的 TokenSource 实现。薄 IO:拼 URL/头 + 错误映射,解析交纯函数。
export class CoinGeckoSource implements TokenSource {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(config: CoinGeckoConfig = {}) {
    this.baseUrl = config.baseUrl ?? (config.pro ? CG_BASE_PRO : CG_BASE_FREE);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.headers = { accept: "application/json" };
    if (config.apiKey) this.headers[config.pro ? HEADER_PRO : HEADER_DEMO] = config.apiKey;
  }

  private async request(path: string, query?: Record<string, string | number>): Promise<unknown> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (query) {
      for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, { headers: this.headers });
    } catch (cause) {
      throw new TokenError("UPSTREAM_ERROR", `coingecko network error: ${path}`, {
        retryable: true,
        cause,
      });
    }

    if (!res.ok) {
      if (res.status === 429) {
        throw new TokenError("RATE_LIMITED", `coingecko rate limited: ${path}`, {
          retryAfterMs: parseRetryAfter(res.headers.get("retry-after")),
        });
      }
      throw new TokenError("UPSTREAM_ERROR", `coingecko ${res.status} on ${path}`, {
        retryable: res.status >= 500,
      });
    }

    try {
      return await res.json();
    } catch (cause) {
      throw new TokenError("PARSE_ERROR", `coingecko bad json: ${path}`, { cause });
    }
  }

  async fetchIndex(): Promise<TokenIndex> {
    const [platformsJson, listJson] = await Promise.all([
      this.request(EP_ASSET_PLATFORMS),
      this.request(EP_COINS_LIST, { include_platform: "true" }),
    ]);
    return buildIndex(platformsJson, listJson, Date.now());
  }

  async fetchMarkets(opts: {
    topN: number;
    vs?: Fiat;
  }): Promise<{ info: TokenInfo; price: TokenPrice }[]> {
    const vs = opts.vs ?? "usd";
    const perPage = Math.min(PER_PAGE_MAX, opts.topN);
    const pages = Math.max(1, Math.ceil(opts.topN / perPage));
    const out: { info: TokenInfo; price: TokenPrice }[] = [];
    for (let page = 1; page <= pages; page++) {
      const json = await this.request(EP_COINS_MARKETS, {
        vs_currency: vs,
        order: "market_cap_desc",
        per_page: perPage,
        page,
        price_change_percentage: PRICE_CHANGE_WINDOWS,
      });
      const rows = parseMarkets(json, vs);
      out.push(...rows);
      if (rows.length < perPage) break; // 末页(不足一页)→ 停
    }
    return out.slice(0, opts.topN);
  }

  async fetchPrices(refs: TokenRef[], opts?: { vs?: Fiat }): Promise<Map<string, TokenPrice>> {
    const vs = opts?.vs ?? "usd";
    const ids = refs
      .filter((r) => r.source === "coingecko")
      .map((r) => r.coinId)
      .join(",");
    if (!ids) return new Map();
    const json = await this.request(EP_SIMPLE_PRICE, {
      ids,
      vs_currencies: vs,
      include_24hr_change: "true",
      include_last_updated_at: "true",
    });
    return parseSimplePrice(json, vs);
  }
}

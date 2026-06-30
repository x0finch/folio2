import {
  TokenError,
  type TokenInfo,
  type TokenPrice,
  type TokenRef,
  type TokenSource,
} from "@folio/tokens";
import {
  CG_BASE_FREE,
  CG_BASE_PRO,
  EP_ASSET_PLATFORMS,
  EP_COINS,
  EP_COINS_MARKETS,
  EP_SEARCH,
  EP_SIMPLE_PRICE,
  HEADER_DEMO,
  HEADER_PRO,
  PER_PAGE_MAX,
  PRICE_CHANGE_WINDOWS,
  VS_USD,
} from "./constants";
import {
  parseAssetPlatforms,
  parseContract,
  parseMarkets,
  parseRetryAfter,
  parseSearch,
  parseSimplePrice,
} from "./parse";

export interface CoinGeckoConfig {
  apiKey?: string;
  pro?: boolean; // pro key → pro 基址 + pro 头;否则 demo 头 + free 基址
  baseUrl?: string; // 覆盖基址(测试/自托管代理)
  fetchImpl?: typeof fetch; // 注入便于测试
}

// CoinGecko 的 TokenSource 实现。薄 IO:拼 URL/头 + 错误映射,解析交纯函数。
// 通用层只给 `chain`;CGK 的 `platform`(asset_platform slug)是本类内部细节 —— 自己 memo 一份
// asset_platforms 表,在 fetchByContract 里把 chain → platform。
export class CoinGeckoSource implements TokenSource {
  private readonly baseUrl: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private platformMap?: Map<string, string>; // chain(slug+chainId) → CGK platform slug,首次按需取

  constructor(config: CoinGeckoConfig = {}) {
    this.baseUrl = config.baseUrl ?? (config.pro ? CG_BASE_PRO : CG_BASE_FREE);
    this.fetchImpl = config.fetchImpl ?? fetch;
    this.headers = { accept: "application/json" };
    if (config.apiKey) this.headers[config.pro ? HEADER_PRO : HEADER_DEMO] = config.apiKey;
  }

  private async request(
    path: string,
    query?: Record<string, string | number>,
    opts?: { notFoundAsNull?: boolean },
  ): Promise<unknown> {
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
      if (res.status === 404 && opts?.notFoundAsNull) return null; // 未收录 → 调用方降级为 null
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

  // chain → CGK platform slug(memo:每实例一次 asset_platforms)。
  private async platformFor(chain: string): Promise<string | undefined> {
    if (!this.platformMap) {
      this.platformMap = parseAssetPlatforms(await this.request(EP_ASSET_PLATFORMS));
    }
    return this.platformMap.get(chain.toLowerCase());
  }

  async fetchByContract(
    chain: string,
    contract: string,
  ): Promise<{ ref: TokenRef; info: TokenInfo; price: TokenPrice } | null> {
    const platform = await this.platformFor(chain);
    if (!platform) return null; // chain 未被 CGK 收录
    const path = `${EP_COINS}/${platform}/contract/${contract.toLowerCase()}`;
    const json = await this.request(path, undefined, { notFoundAsNull: true });
    return json === null ? null : parseContract(json);
  }

  async fetchMarkets(opts: { topN: number }): Promise<{ info: TokenInfo; price: TokenPrice }[]> {
    const perPage = Math.min(PER_PAGE_MAX, opts.topN);
    const pages = Math.max(1, Math.ceil(opts.topN / perPage));
    const out: { info: TokenInfo; price: TokenPrice }[] = [];
    for (let page = 1; page <= pages; page++) {
      const json = await this.request(EP_COINS_MARKETS, {
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
  }

  async searchCoins(query: string): Promise<TokenInfo[]> {
    const q = query.trim();
    if (!q) return [];
    return parseSearch(await this.request(EP_SEARCH, { query: q }));
  }

  async fetchPrices(refs: TokenRef[]): Promise<Map<string, TokenPrice>> {
    const ids = refs
      .filter((r) => r.source === "coingecko")
      .map((r) => r.coinId)
      .join(",");
    if (!ids) return new Map();
    const json = await this.request(EP_SIMPLE_PRICE, {
      ids,
      vs_currencies: VS_USD,
      include_24hr_change: "true",
      include_last_updated_at: "true",
    });
    return parseSimplePrice(json);
  }
}

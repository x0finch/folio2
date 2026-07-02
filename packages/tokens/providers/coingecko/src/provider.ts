import {
  TokenError,
  type TokenInfo,
  type TokenPrice,
  type TokenProvider,
} from "@folio/tokens-basic";
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
  USER_AGENT,
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
}

// 单次请求的 IO 依赖(基址 + 头),作为参数传给独立的 `request`——不藏在闭包/this 里。
// 直接用全局 `fetch`(与各 provider 一致);测试用 `vi.spyOn(globalThis, "fetch")` mock。
interface HttpCtx {
  baseUrl: string;
  headers: Record<string, string>;
}

// 薄 IO + 错误映射:429→RATE_LIMITED、404(notFoundAsNull)→null、其余非 2xx→UPSTREAM_ERROR、坏 JSON→PARSE_ERROR。
async function request(
  http: HttpCtx,
  path: string,
  query?: Record<string, string | number>,
  opts?: { notFoundAsNull?: boolean },
): Promise<unknown> {
  const url = new URL(`${http.baseUrl}${path}`);
  if (query) {
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, String(v));
  }

  let res: Response;
  try {
    res = await fetch(url, { headers: http.headers });
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

// CoinGecko 的 `TokenProvider` 实现(functional 工厂,对齐 `createTokenStore`/`defineProvider`——无 class/this)。
// 薄 IO:拼 URL/头 + 错误映射,解析交纯函数。通用层只给 `chain`;CGK 的 `platform`(asset_platform
// slug)是内部细节 —— 闭包 memo 一份 asset_platforms 表,在 fetchByContract 里把 chain → platform。
export function createCoinGeckoProvider(config: CoinGeckoConfig = {}): TokenProvider {
  const baseUrl = config.baseUrl ?? (config.pro ? CG_BASE_PRO : CG_BASE_FREE);
  const headers: Record<string, string> = { accept: "application/json", "user-agent": USER_AGENT };
  if (config.apiKey) headers[config.pro ? HEADER_PRO : HEADER_DEMO] = config.apiKey;

  const http: HttpCtx = { baseUrl, headers };
  let platformMap: Map<string, string> | undefined; // chain(slug+chainId) → CGK platform slug,首次按需取

  // chain → CGK platform slug(memo:每实例一次 asset_platforms)。
  const platformFor = async (chain: string): Promise<string | undefined> => {
    if (!platformMap) {
      platformMap = parseAssetPlatforms(await request(http, EP_ASSET_PLATFORMS));
    }
    return platformMap.get(chain.toLowerCase());
  };

  return {
    source: "coingecko",
    async fetchByContract(chain, contract) {
      const platform = await platformFor(chain);
      if (!platform) return null; // chain 未被 CGK 收录
      const path = `${EP_COINS}/${platform}/contract/${contract.toLowerCase()}`;
      const json = await request(http, path, undefined, { notFoundAsNull: true });
      return json === null ? null : parseContract(json);
    },

    async fetchMarkets(opts) {
      const perPage = Math.min(PER_PAGE_MAX, opts.topN);
      const pages = Math.max(1, Math.ceil(opts.topN / perPage));
      const out: { info: TokenInfo; price: TokenPrice }[] = [];
      for (let page = 1; page <= pages; page++) {
        const json = await request(http, EP_COINS_MARKETS, {
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
      return parseSearch(await request(http, EP_SEARCH, { query: q }));
    },

    async fetchPrices(refs) {
      const ids = refs
        .filter((r) => r.source === "coingecko")
        .map((r) => r.identifier)
        .join(",");
      if (!ids) return new Map();
      const json = await request(http, EP_SIMPLE_PRICE, {
        ids,
        vs_currencies: VS_USD,
        include_24hr_change: "true",
        include_last_updated_at: "true",
      });
      return parseSimplePrice(json);
    },
  };
}

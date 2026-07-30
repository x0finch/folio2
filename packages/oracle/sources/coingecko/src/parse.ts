import {
  cgkRef,
  TokenError,
  type TokenInfo,
  type TokenPrice,
  type TokenPricePoint,
  type TokenRef,
} from "@folio/oracle-basic";
import { SEARCH_LIMIT, VS_USD } from "./constants";

// Retry-After 解析已移入 @folio/coingecko-client;re-export 保持既有导入面(含测试)。

const cg = cgkRef;

interface RawPlatform {
  id?: string;
  chain_identifier?: number | null;
}

// 链→平台:slug 与 EVM chainId 双键都映射到 CGK 平台 slug(非 EVM 仅 slug 键)。
export function parseAssetPlatforms(json: unknown): Map<string, string> {
  if (!Array.isArray(json)) throw new TokenError("PARSE_ERROR", "asset_platforms: expected array");
  const platforms = new Map<string, string>();
  for (const p of json as RawPlatform[]) {
    if (!p?.id) continue;
    platforms.set(p.id.toLowerCase(), p.id);
    if (p.chain_identifier != null) platforms.set(String(p.chain_identifier), p.id);
  }
  return platforms;
}

interface RawMarket {
  id?: string;
  symbol?: string;
  name?: string;
  image?: string;
  current_price?: number | null; // 已是 USD(查询时 vs_currency=usd)
  market_cap_rank?: number | null;
  price_change_percentage_24h?: number | null;
  last_updated?: string;
}

// 一行 markets → {info, price}(价facet + 元信息facet;价为 USD)。跳过无 id / 无价的行。
export function parseMarkets(json: unknown): { info: TokenInfo; price: TokenPrice }[] {
  if (!Array.isArray(json)) throw new TokenError("PARSE_ERROR", "coins/markets: expected array");
  const out: { info: TokenInfo; price: TokenPrice }[] = [];
  for (const r of json as RawMarket[]) {
    if (!r?.id || typeof r.current_price !== "number") continue;
    const ref = cg(r.id);
    const asOf = r.last_updated ? Date.parse(r.last_updated) : Number.NaN;
    out.push({
      info: { ref, symbol: r.symbol ?? "", name: r.name ?? "", logo: r.image },
      price: {
        ref,
        unitPrice: r.current_price,
        change24h: r.price_change_percentage_24h ?? undefined,
        marketCapRank: r.market_cap_rank ?? undefined,
        asOf: Number.isFinite(asOf) ? asOf : 0,
      },
    });
  }
  return out;
}

// simple/price → 按 tokenRef 串索引的价(USD)。字段键固定为 usd / usd_24h_change(查询时 vs=usd)。
export function parseSimplePrice(json: unknown): Map<string, TokenPrice> {
  if (typeof json !== "object" || json === null)
    throw new TokenError("PARSE_ERROR", "simple/price: expected object");
  const out = new Map<string, TokenPrice>();
  for (const [id, raw] of Object.entries(json as Record<string, Record<string, number>>)) {
    const unitPrice = raw?.[VS_USD];
    if (typeof unitPrice !== "number") continue;
    const change = raw[`${VS_USD}_24h_change`];
    const ts = raw.last_updated_at;
    const ref = cg(id);
    out.set(ref, {
      ref,
      unitPrice,
      change24h: typeof change === "number" ? change : undefined,
      asOf: typeof ts === "number" ? ts * 1000 : 0,
    });
  }
  return out;
}

// market_chart/range 的 prices 对 [msTimestamp, unitPrice] → 升序原始观测点(USD)。
// 丢弃非二元组 / 非有限值;按 atMs 升序(CGK 本已升序,防御性再排)。日级归一在 tokens 服务侧做。
export function parsePriceSeries(pairs: [number, number][]): TokenPricePoint[] {
  const out: TokenPricePoint[] = [];
  for (const pair of pairs) {
    if (!Array.isArray(pair) || pair.length < 2) continue;
    const [atMs, unitPrice] = pair;
    if (Number.isFinite(atMs) && Number.isFinite(unitPrice)) out.push({ atMs, unitPrice });
  }
  out.sort((a, b) => a.atMs - b.atMs);
  return out;
}

interface RawContract {
  id?: string;
  symbol?: string;
  name?: string;
  image?: { thumb?: string; small?: string; large?: string }; // per-contract:image 是对象(非 markets 的 string)
  market_cap_rank?: number | null;
  market_data?: {
    current_price?: Record<string, number>;
    price_change_percentage_24h?: number | null;
  };
  last_updated?: string;
}

// per-contract 端点(coins/{platform}/contract/{addr})→ {ref, info, price}(价 USD)。无 id / 无价 → null。
export function parseContract(
  json: unknown,
): { ref: TokenRef; info: TokenInfo; price: TokenPrice } | null {
  const c = json as RawContract;
  const unitPrice = c?.market_data?.current_price?.[VS_USD];
  if (!c?.id || typeof unitPrice !== "number") return null;
  const ref = cg(c.id);
  const asOf = c.last_updated ? Date.parse(c.last_updated) : Number.NaN;
  return {
    ref,
    info: {
      ref,
      symbol: c.symbol ?? "",
      name: c.name ?? "",
      logo: c.image?.large ?? c.image?.small,
    },
    price: {
      ref,
      unitPrice,
      change24h: c.market_data?.price_change_percentage_24h ?? undefined,
      marketCapRank: c.market_cap_rank ?? undefined,
      asOf: Number.isFinite(asOf) ? asOf : 0,
    },
  };
}

interface RawSearchCoin {
  id?: string;
  symbol?: string;
  name?: string;
  market_cap_rank?: number | null;
  large?: string;
  thumb?: string;
}

// /search → coins[] → TokenInfo[](选币 autocomplete 用)。按 market_cap_rank 升序(无排名末尾)
// **排序后再截** SEARCH_LIMIT(先切会漏掉靠后但市值更高的项);logo 用 large 退 thumb。
export function parseSearch(json: unknown): TokenInfo[] {
  const coins = (json as { coins?: RawSearchCoin[] })?.coins;
  if (!Array.isArray(coins)) throw new TokenError("PARSE_ERROR", "search: expected { coins: [] }");
  const rank = (c: RawSearchCoin) => c.market_cap_rank ?? Number.POSITIVE_INFINITY;
  const sorted = [...coins].sort((a, b) => rank(a) - rank(b));
  const out: TokenInfo[] = [];
  for (const c of sorted.slice(0, SEARCH_LIMIT)) {
    if (!c?.id || !c.symbol) continue;
    out.push({ ref: cg(c.id), symbol: c.symbol, name: c.name ?? "", logo: c.large ?? c.thumb });
  }
  return out;
}

import type {
  CoinContract,
  MarketCoin,
  SearchResult,
  SimplePriceMap,
} from "@folio/coingecko-client2";
import type { TokenPrice, TokenPricePoint, TokenRef, UpstreamToken } from "@folio/oracle-basic";
import { parseTokenRef, tokenRef } from "@folio/oracle-ref";
import { SEARCH_LIMIT, UPSTREAM_ID, VS_USD } from "./constants";

// CoinGecko 响应 → 契约形状的纯解析。零 IO,fixture 可钉死。
// 产出的 tokenRef 命名者恒为本 adapter 的 id;coin id 规范为小写 kebab,归一在生产者侧做。

export const cgkRef = (coinId: string): TokenRef =>
  tokenRef.issued(UPSTREAM_ID, coinId.toLowerCase());

// coin id ← 本源命名的 ref。不是本源的命名(链上寻址 / 别家)→ undefined。
//
// **走文法拆,不切前缀。** 光比左段不够:`coingecko/contract:0x…` 左段也是本源,右段却是个地址。
// 全仓没有生产者产这种串(contract 形的命名者恒是链;本源产的恒是 `issued:`),它只能从
// **手搓的票**进来 —— `getTokenPrice` 收的 ticket 只过文法校验,而那个串文法合法。
// 切前缀的后果不严重(把 `contract:0x…` 当 coin id 发上去,换回一个空结果),但白跑一趟,
// 而按形状问一句就没有这一趟。要的是「本源**发的标识**」这一支(ADR 0020 第四轮)。
export function coinIdOf(ref: TokenRef): string | undefined {
  const parsed = parseTokenRef(ref);
  return parsed.kind === "issued" && parsed.namer === UPSTREAM_ID ? parsed.id : undefined;
}

// 一行 markets → UpstreamToken(元信息 + 价;价为 USD)。跳过无 id 的行。
export function parseMarkets(rows: readonly MarketCoin[]): UpstreamToken[] {
  const out: UpstreamToken[] = [];
  for (const m of rows) {
    if (!m?.id || !m.symbol) continue;
    const asOf = Date.parse(m.last_updated ?? "") || Date.now();
    out.push({
      ref: cgkRef(m.id),
      symbol: m.symbol,
      name: m.name ?? m.symbol,
      logo: m.image ?? undefined,
      price: {
        unitPrice: m.current_price ?? 0,
        change24h: m.price_change_percentage_24h ?? undefined,
        marketCapRank: m.market_cap_rank ?? undefined,
        asOf,
      },
    });
  }
  return out;
}

// /search → 前 N 条(选币 autocomplete)。无价,但**带 rank**:`/search` 也给 `market_cap_rank`,
// 挂在顶层 `marketCapRank`(这条路没有 price 可放)。选币下拉只拿它当消歧徽标(有没有 / 大概多前),
// 不参与排序 —— 它与 markets 端点的 rank 系统性对不上(#226),不可比但够消歧。
export function parseSearch(json: SearchResult): UpstreamToken[] {
  const out: UpstreamToken[] = [];
  for (const c of json?.coins ?? []) {
    if (!c?.id || !c.symbol) continue;
    out.push({
      ref: cgkRef(c.id),
      symbol: c.symbol,
      name: c.name ?? c.symbol,
      logo: c.large ?? c.thumb ?? undefined,
      marketCapRank: c.market_cap_rank ?? undefined,
    });
    if (out.length >= SEARCH_LIMIT) break;
  }
  return out;
}

// /simple/price → ref → 价。缺 usd 的条目跳过。
export function parseSimplePrice(
  json: SimplePriceMap,
  asOfFallback: number,
): Map<TokenRef, TokenPrice> {
  const out = new Map<TokenRef, TokenPrice>();
  for (const [coinId, v] of Object.entries(json ?? {})) {
    const unitPrice = v?.[VS_USD];
    if (typeof unitPrice !== "number") continue;
    const lastUpdated = v[`${VS_USD}_last_updated_at`];
    out.set(cgkRef(coinId), {
      unitPrice,
      change24h: v[`${VS_USD}_24h_change`],
      asOf: typeof lastUpdated === "number" ? lastUpdated * 1000 : asOfFallback,
    });
  }
  return out;
}

// /coins/{platform}/contract/{addr} → UpstreamToken(兜底单查)。
export function parseContract(json: CoinContract | null): UpstreamToken | null {
  if (!json?.id || !json.symbol) return null;
  const md = json.market_data;
  const unitPrice = md?.current_price?.[VS_USD];
  return {
    ref: cgkRef(json.id),
    symbol: json.symbol,
    name: json.name ?? json.symbol,
    logo: json.image?.large ?? json.image?.small ?? json.image?.thumb ?? undefined,
    price:
      typeof unitPrice === "number"
        ? {
            unitPrice,
            change24h: md?.price_change_percentage_24h ?? undefined,
            marketCapRank: json.market_cap_rank ?? undefined,
            asOf: Date.parse(json.last_updated ?? "") || Date.now(),
          }
        : undefined,
  };
}

// market_chart/range 的 [msTimestamp, price] 对 → 升序观测点。
export function parsePriceSeries(pairs: readonly [number, number][]): TokenPricePoint[] {
  return pairs
    .filter(([atMs, unitPrice]) => Number.isFinite(atMs) && Number.isFinite(unitPrice))
    .map(([atMs, unitPrice]) => ({ atMs, unitPrice }))
    .sort((a, b) => a.atMs - b.atMs);
}

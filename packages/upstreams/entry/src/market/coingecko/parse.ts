import type { TokenPrice, TokenPricePoint, TokenRef, UpstreamToken } from "@folio/oracle-basic";
import { parseTokenRef, tokenRef } from "@folio/oracle-ref";
import type { MarketCoin, SearchResult, SimplePriceMap } from "./api";
import { ID, LAST_UPDATED_AT, SEARCH_LIMIT, VS_USD } from "./constants";

// Pure parsing of CoinGecko responses into contract shapes; zero IO.
// Produced tokenRefs always name this adapter; coin ids are lowercase kebab.

export const cgkRef = (coinId: string): TokenRef => tokenRef.issued(ID, coinId.toLowerCase());

// coin id from a ref named by this upstream; anything else is undefined.
// Parse by grammar, not prefix: `coingecko/contract:0x…` shares the namer but its local name is an address,
// and a hand-built ticket can carry it. Only the `issued:` shape is a CoinGecko id.
export function coinIdOf(ref: TokenRef): string | undefined {
  const parsed = parseTokenRef(ref);
  return parsed.kind === "issued" && parsed.namer === ID ? parsed.id : undefined;
}

// One markets row to UpstreamToken (price in USD); rows without id are skipped.
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

// /search top N for the token picker. No price, but carries `market_cap_rank` as a disambiguation badge only;
// it is not comparable with the markets endpoint's rank.
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

// /simple/price: ref to price; entries without usd are skipped.
export function parseSimplePrice(
  json: SimplePriceMap,
  asOfFallback: number,
): Map<TokenRef, TokenPrice> {
  const out = new Map<TokenRef, TokenPrice>();
  for (const [coinId, v] of Object.entries(json ?? {})) {
    const unitPrice = v?.[VS_USD];
    if (typeof unitPrice !== "number") continue;
    // The timestamp field has no `usd_` prefix (`include_last_updated_at` returns `last_updated_at`).
    const lastUpdated = v[LAST_UPDATED_AT];
    out.set(cgkRef(coinId), {
      unitPrice,
      change24h: v[`${VS_USD}_24h_change`],
      asOf: typeof lastUpdated === "number" ? lastUpdated * 1000 : asOfFallback,
    });
  }
  return out;
}

// market_chart/range [msTimestamp, price] pairs to ascending points.
export function parsePriceSeries(pairs: readonly (readonly [number, number])[]): TokenPricePoint[] {
  return pairs
    .filter(([atMs, unitPrice]) => Number.isFinite(atMs) && Number.isFinite(unitPrice))
    .map(([atMs, unitPrice]) => ({ atMs, unitPrice }))
    .sort((a, b) => a.atMs - b.atMs);
}

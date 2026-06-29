import {
  type CoinId,
  type Fiat,
  normalizeSymbol,
  refKey,
  type TokenCandidate,
  TokenError,
  type TokenIndex,
  type TokenInfo,
  type TokenPrice,
  type TokenRef,
} from "@folio/tokens";

const cg = (id: string): TokenRef => ({ source: "coingecko", coinId: id as CoinId });

// Retry-After:数字秒 / HTTP-date → ms(平行 @folio/core 的同名 helper;本包不依赖 core)。
// `now` 可注入以便测 HTTP-date 分支。
export function parseRetryAfter(header: string | null, now = Date.now()): number | undefined {
  if (!header) return undefined;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const date = Date.parse(header);
  if (Number.isFinite(date)) return Math.max(0, date - now);
  return undefined;
}

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

interface RawCoin {
  id?: string;
  symbol?: string;
  name?: string;
  platforms?: Record<string, string | null>;
}

// coins/list?include_platform → (平台,合约)→ref 与 symbol→候选。候选 rank 暂空(P7.3 灌 markets 时合并)。
export function parseCoinsList(json: unknown): {
  byContract: Map<string, TokenRef>;
  bySymbol: Map<string, TokenCandidate[]>;
} {
  if (!Array.isArray(json)) throw new TokenError("PARSE_ERROR", "coins/list: expected array");
  const byContract = new Map<string, TokenRef>();
  const bySymbol = new Map<string, TokenCandidate[]>();
  for (const c of json as RawCoin[]) {
    if (!c?.id || !c.symbol) continue;
    const ref = cg(c.id);
    const symKey = normalizeSymbol(c.symbol);
    const list = bySymbol.get(symKey);
    if (list) list.push({ ref });
    else bySymbol.set(symKey, [{ ref }]);
    if (c.platforms) {
      for (const [platform, addr] of Object.entries(c.platforms)) {
        if (!platform || !addr) continue;
        byContract.set(`${platform}:${addr.toLowerCase()}`, ref);
      }
    }
  }
  return { byContract, bySymbol };
}

export function buildIndex(platformsJson: unknown, listJson: unknown, asOf: number): TokenIndex {
  const platforms = parseAssetPlatforms(platformsJson);
  const { byContract, bySymbol } = parseCoinsList(listJson);
  return { byContract, bySymbol, platforms, asOf };
}

interface RawMarket {
  id?: string;
  symbol?: string;
  name?: string;
  image?: string;
  current_price?: number | null;
  market_cap_rank?: number | null;
  price_change_percentage_24h?: number | null;
  last_updated?: string;
}

// 一行 markets → {info, price}(价facet + 元信息facet)。跳过无 id / 无价的行。
export function parseMarkets(json: unknown, vs: Fiat): { info: TokenInfo; price: TokenPrice }[] {
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
        vs,
        asOf: Number.isFinite(asOf) ? asOf : 0,
      },
    });
  }
  return out;
}

// simple/price → 按 refKey 索引的价。
export function parseSimplePrice(json: unknown, vs: Fiat): Map<string, TokenPrice> {
  if (typeof json !== "object" || json === null)
    throw new TokenError("PARSE_ERROR", "simple/price: expected object");
  const out = new Map<string, TokenPrice>();
  for (const [id, raw] of Object.entries(json as Record<string, Record<string, number>>)) {
    const unitPrice = raw?.[vs];
    if (typeof unitPrice !== "number") continue;
    const change = raw[`${vs}_24h_change`];
    const ts = raw.last_updated_at;
    const ref = cg(id);
    out.set(refKey(ref), {
      ref,
      unitPrice,
      change24h: typeof change === "number" ? change : undefined,
      vs,
      asOf: typeof ts === "number" ? ts * 1000 : 0,
    });
  }
  return out;
}

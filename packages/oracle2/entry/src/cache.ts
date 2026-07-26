import type {
  CacheStore,
  TokenCandidate,
  TokenInfo,
  TokenMetaUpstream,
  TokenPrice,
} from "@folio/oracle2-basic";
import { FX_TTL_MS, normalizeSymbol, PLATFORM_TTL_MS, WARM_TTL_MS } from "@folio/oracle2-basic";
import { swr } from "./refresh";

// 参考层的三样缓存,一张 per-user 的 KV 表,**只三种键**:
//   warm            市值前 N 名,整份一个 JSON blob
//   fx:<币种>       展示币种汇率
//   platform:<键>   链 ∪ 场馆的名与图
//
// 界线:**整份都要用 → JSON;只挑几行用 → 表**。warm 每次都是整份读(排行榜、symbol 候选都从它出),
// 所以是 blob;全局映射每次只挑那么几行,所以是表(ADR 0022)。
//
// symbol 消歧的候选**不单独存** —— 候选恒是 warm 集的子集,从同一个 blob 里筛就行。
// 整张表删空功能不坏,只是下一次访问要回一趟上游。

export const cacheKeys = {
  warm: "warm",
  fx: (currency: string) => `fx:${currency.trim().toUpperCase()}`,
  platform: (key: string) => `platform:${key}`,
} as const;

// warm blob:一次整份写、一次整份读。行的形状沿用现有 `putWarm` 的 `{ info, price }` 对。
export interface WarmBlob {
  asOf: number;
  rows: { info: WarmInfo; price: TokenPrice }[];
}

// warm 里的 info 还没进库 → 没有内部 id、`ref` 必然非空(与 `UpstreamToken` 同源)。
export type WarmInfo = Omit<TokenInfo, "id" | "ref" | "providerLogo"> & { ref: string };

export interface PlatformMeta {
  name: string;
  logo?: string;
}

// —— warm ——

// 排行榜 / 候选都读它。**整份刷新走 SWR**:新鲜就不碰上游(与价、历史价同一个编排函数)。
export async function warmRows(
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
  now: number,
): Promise<WarmBlob["rows"]> {
  const blob = await swr<WarmBlob>({
    read: async () => {
      const hit = await cache.get(cacheKeys.warm);
      const value = hit?.value as WarmBlob | undefined;
      return value && Array.isArray(value.rows) ? { value, stale: hit?.stale ?? true } : undefined;
    },
    fetch: async () => {
      const tokens = await upstream.fetchMarkets({ topN });
      return {
        asOf: now,
        rows: tokens.map((t) => ({
          info: { symbol: t.symbol, name: t.name, logo: t.logo, ref: t.ref },
          price: t.price ?? { unitPrice: 0, asOf: now },
        })),
      };
    },
    // **一次整份写**,不是逐行 upsert —— 前 N 名是一个快照,逐行写会写出半新半旧的榜。
    write: (value) => cache.put(cacheKeys.warm, value, WARM_TTL_MS),
  });
  return blob?.rows ?? [];
}

// 市值升序取前 limit(无 rank 者垫底)。
export function topByRank(rows: WarmBlob["rows"], limit: number): WarmBlob["rows"] {
  const rank = (r: WarmBlob["rows"][number]) => r.price.marketCapRank ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

// 按 symbol 筛候选。**与排行榜同一份 rows** —— 候选不额外存一份。
export function candidatesBySymbol(rows: WarmBlob["rows"], symbol: string): TokenCandidate[] {
  const want = normalizeSymbol(symbol);
  const out: TokenCandidate[] = [];
  for (const r of rows) {
    if (normalizeSymbol(r.info.symbol) !== want) continue;
    out.push({ ref: r.info.ref, marketCapRank: r.price.marketCapRank });
  }
  return out;
}

// —— fx / platform ——
// 同一张表的另两种键,差别只在 TTL:汇率要新鲜(短),链和场馆的名与图近乎静态(长)。

export async function readFx(cache: CacheStore, currency: string): Promise<number | undefined> {
  const hit = await cache.get(cacheKeys.fx(currency));
  return typeof hit?.value === "number" ? hit.value : undefined;
}

export function writeFx(cache: CacheStore, currency: string, usdPerUnit: number): Promise<void> {
  return cache.put(cacheKeys.fx(currency), usdPerUnit, FX_TTL_MS);
}

export async function readPlatform(
  cache: CacheStore,
  key: string,
): Promise<PlatformMeta | undefined> {
  const hit = await cache.get(cacheKeys.platform(key));
  const meta = hit?.value as PlatformMeta | undefined;
  return meta && typeof meta.name === "string" ? meta : undefined;
}

export function writePlatform(cache: CacheStore, key: string, meta: PlatformMeta): Promise<void> {
  return cache.put(cacheKeys.platform(key), meta, PLATFORM_TTL_MS);
}

import { parseTokenRef } from "@folio/oracle-ref";
import { FX_TTL_MS, normalizeSymbol, PLATFORM_TTL_MS, WARM_TTL_MS } from "./constants";
import type {
  CacheStore,
  CandidateSource,
  SourceToken,
  SymbolCandidate,
  TokenSource,
} from "./stores";

// 参考层的三样缓存,一张 per-user 的 KV 表,**只三种键**:
//   warm            市值前 N 名,整份一个 JSON blob
//   fx:<币种>       展示币种汇率
//   platform:<键>   链 ∪ 场馆的名与图
//
// 界线:**整份都要用 → JSON;只挑几行用 → 表**。warm 每次都是整份读(排行榜、symbol 候选都从它出),
// 所以是 blob;`cgk_refs` 每次只挑那么几行,所以是表(ADR 0022)。
//
// symbol 消歧的候选**不单独存** —— 候选恒是 warm 集的子集,从同一个 blob 里筛就行。
// 整张表删空功能不坏,只是下一次访问要回一趟上游。

export const cacheKeys = {
  warm: "warm",
  fx: (currency: string) => `fx:${currency.trim().toUpperCase()}`,
  platform: (key: string) => `platform:${key}`,
} as const;

// warm blob 的形状:一次整份写、一次整份读。
export interface WarmBlob {
  asOf: number;
  tokens: SourceToken[];
}

export interface PlatformMeta {
  name: string;
  logo?: string;
}

// —— warm ——

// TTL 门控的整份刷新:没过期就不拉。返回是否真的拉了(调用方用于日志/计数)。
export async function refreshWarm(
  cache: CacheStore,
  source: TokenSource,
  topN: number,
  now: number,
): Promise<boolean> {
  const hit = await readWarm(cache);
  if (hit && !hit.stale) return false;
  const tokens = await source.fetchMarkets(topN);
  // **一次整份写**,不是逐行 upsert —— 前 N 名是一个快照,逐行写会写出半新半旧的榜。
  await cache.put(cacheKeys.warm, { asOf: now, tokens } satisfies WarmBlob, WARM_TTL_MS);
  return true;
}

export async function readWarm(
  cache: CacheStore,
): Promise<{ blob: WarmBlob; stale: boolean } | undefined> {
  const hit = await cache.get(cacheKeys.warm);
  if (!hit) return undefined;
  const blob = hit.value as WarmBlob;
  if (!blob || !Array.isArray(blob.tokens)) return undefined;
  return { blob, stale: hit.stale };
}

// 排行榜(默认选币列表)。冷缓存 → 空,调用方自行决定要不要先 refreshWarm。
export async function topTokens(cache: CacheStore, limit: number): Promise<SourceToken[]> {
  const hit = await readWarm(cache);
  if (!hit) return [];
  return [...hit.blob.tokens]
    .sort(
      (a, b) =>
        (a.price?.marketCapRank ?? Number.POSITIVE_INFINITY) -
        (b.price?.marketCapRank ?? Number.POSITIVE_INFINITY),
    )
    .slice(0, limit);
}

// symbol 消歧的候选源(喂 mint)。**与排行榜同一个 blob** —— 候选不额外存一份。
export function warmCandidates(cache: CacheStore): CandidateSource {
  return {
    async bySymbol(symbol: string): Promise<SymbolCandidate[]> {
      const hit = await readWarm(cache);
      if (!hit) return [];
      const want = normalizeSymbol(symbol);
      const out: SymbolCandidate[] = [];
      for (const t of hit.blob.tokens) {
        if (normalizeSymbol(t.symbol) !== want) continue;
        const coinId = localNameOf(t.ref);
        if (coinId) out.push({ coinId, marketCapRank: t.price?.marketCapRank });
      }
      return out;
    },
  };
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

// ref 的右半边 = 上游对这个币的 id。warm 里的 ref 恒由本源产出,故正常必有值。
function localNameOf(ref: string): string | undefined {
  const parsed = parseTokenRef(ref);
  return parsed.kind === "local" ? parsed.localName : undefined;
}

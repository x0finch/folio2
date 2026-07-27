import type {
  CacheStore,
  TokenCandidate,
  TokenInfo,
  TokenMetaUpstream,
  TokenPrice,
} from "@folio/oracle2-basic";
import {
  FX_TTL_MS,
  normalizeSymbol,
  PLATFORM_TTL_MS,
  PRICE_TTL_MS,
  WARM_TTL_MS,
} from "@folio/oracle2-basic";
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
// 也没有 `infoStale`:那是「库里那行该回源刷了吗」,而这份**就是**刚从上游拿的。
export type WarmInfo = Omit<TokenInfo, "id" | "ref" | "providerLogo" | "infoStale"> & {
  ref: string;
};

export interface PlatformMeta {
  name: string;
  logo?: string;
}

// —— warm ——
//
// **同一份 blob,两个读者,新鲜度判据不同**(#216)。里面那 8 个字段的寿命差三个数量级:
//   价 / 24h 涨跌  分钟级      ← 只有橱窗在乎
//   市值排名        天级
//   symbol / 名 / 图  几乎不变  ← 候选源只要这些
//
// blob 整份读整份写,所以**不能**让它整体按最短的那个刷 —— 那会让 mint(写路径、用户在等)
// 为了一份「哪个币叫 POL」的数据去等 4 次目录请求。判据因此从「缓存条目过没过期」挪到
// **blob 自己的 `asOf`** 上,由各读者按自己的容忍度判。
//
// `WARM_TTL_MS` 于是只剩「缓存条目上盖的过期戳」这一个作用:两个读者都不看 `hit.stale`
// (store 本来就过期不删)。留着它是为了让那个戳有个合理的值,万一日后有第三个读者。

async function warmBlob(
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
  now: number,
  isStale: (blob: WarmBlob) => boolean,
): Promise<WarmBlob["rows"]> {
  const blob = await swr<WarmBlob>({
    read: async () => {
      const hit = await cache.get(cacheKeys.warm);
      const value = hit?.value as WarmBlob | undefined;
      if (!value || !Array.isArray(value.rows)) return undefined; // 没有 → 回源(躲不掉)
      return { value, stale: isStale(value) };
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

/**
 * 目录读者(symbol 消歧的候选源)。**有就用,多旧都用;只有完全没有时才回源一次。**
 *
 * 它问的是「哪个币叫 POL」—— 这个答案几乎不变,不值得让写路径为它出网。而完全没有时躲不掉:
 * 候选集为空意味着所有按 symbol 认的币(交易所持仓、没选币的手记)全都认不出来,新用户
 * 第一次同步会集体没有价。因为 `user_cache` 过期不删,这一取一辈子只会发生一次。
 *
 * 代价:某个币新进前 1000,要等下一次橱窗刷新(或预热)之后才认得出来。可接受 —— 它本来
 * 也得先爬进前 1000。
 */
export function warmCatalogue(
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
  now: number,
): Promise<WarmBlob["rows"]> {
  return warmBlob(cache, upstream, topN, now, () => false);
}

/**
 * 橱窗读者(选币下拉的默认列)。**价旧了就刷** —— 用户正看着这些数字,而且是他自己点开的,
 * 这一趟网络他等得起。判据是 blob 的 `asOf`,与缓存条目的过期戳无关。
 */
export function warmMarkets(
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
  now: number,
): Promise<WarmBlob["rows"]> {
  return warmBlob(cache, upstream, topN, now, (blob) => now - blob.asOf > PRICE_TTL_MS);
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

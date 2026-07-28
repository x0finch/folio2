import type {
  CacheEntry,
  CacheStore,
  TokenCandidate,
  TokenInfo,
  TokenMetaUpstream,
  TokenPrice,
} from "@folio/oracle2-basic";
import {
  FX_TTL_MS,
  normalizeSymbol,
  PLATFORM_NEG_TTL_MS,
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

// 平台缓存里存的一条。**`name: null` = 否定缓存** —— 问过上游、它的链表里没有这个键。
// 与「这条压根没有」必须分开:后者会让每一次预热都为了这一个键重拉整张链表。
export interface PlatformEntry {
  name: string | null;
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
// 三个读者,三条判据:
//   warmCatalogue    mint(写路径)      **永不刷**,只有完全没有时取一次
//   warmMarkets      选币下拉(用户在等) 价超过 PRICE_TTL_MS 就刷
//   refreshCatalogue 同步后的后台预热    目录超过 WARM_TTL_MS(一周)就刷 ← 唯一主动跟进的那条
//
// 没有第三条的话,不打开选币下拉的用户目录会冻在第一次同步那一刻,此后新进前 1000 的币永远
// 认不出来。三条都不看 `hit.stale`(store 过期不删),判据一律落在 blob 的 `asOf` 上。

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
  return dedupeByRef(blob?.rows ?? []);
}

// 目录是一个**集合**:一个币一行。在**读**这一侧兜住,而不只是在上游那侧去重,有两个理由:
//   · 已经存进缓存的脏目录得治 —— 这份 blob 一周才刷一次,不然修完还要脏一周
//   · 三个读者(mint 的候选、选币下拉、搜索)一处覆盖,不用各防一遍
//
// 重复不是假想:上游的分页来自不同快照,同一个币会在两页各出现一次(见 coingecko adapter 的注释)。
// 后果都是静默的 —— 按 symbol 认币时它会跟**自己**比排名、永远碾压不了「次席」,于是那个币
// 认不出来;选币列表那边则是同一个 key 出现两次,React 卸载了却摘不干净 DOM,留下僵尸行。
function dedupeByRef(rows: WarmBlob["rows"]): WarmBlob["rows"] {
  const seen = new Set<string>();
  const out: WarmBlob["rows"] = [];
  for (const r of rows) {
    if (seen.has(r.info.ref)) continue; // 先出现的胜出(它排得更靠前)
    seen.add(r.info.ref);
    out.push(r);
  }
  return out;
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
 * 预热读者(同步之后在后台跑)。**目录旧了就整份刷一次** —— 这是唯一一条「主动让目录跟上」的路。
 *
 * 为什么不能指望前两个:`warmCatalogue` 按设计永不刷(它在写路径上),`warmMarkets` 只在用户
 * 打开选币下拉时才跑 —— 从不开下拉的用户,候选集会冻在第一次同步那一刻,此后新进前 1000 的币
 * 永远认不出来。
 *
 * 跑在同步后的 best-effort 预热里(`waitUntil`,吞错),所以这 4 次请求不在任何人的关键路径上。
 */
export function refreshCatalogue(
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
  now: number,
): Promise<WarmBlob["rows"]> {
  return warmBlob(cache, upstream, topN, now, (blob) => now - blob.asOf > WARM_TTL_MS);
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
// 同一张表的另两种键。**都走批量** —— 汇率一次上游响应写十来个币种,平台展示一次要这个用户的
// 全部链;逐键往返会把 1 次 D1 变成 N 次。TTL 各键自带:汇率慢变但不静态(6h),
// 链和场馆的名与图近乎静态(30d),而「问过、上游没有」只记 1d(新链随时可能被收录)。

export async function readFx(cache: CacheStore, currency: string): Promise<number | undefined> {
  const hit = await cache.get(cacheKeys.fx(currency));
  return typeof hit?.value === "number" ? hit.value : undefined;
}

// 一批币种的新鲜度(预热用):miss 的键不出现,命中的带 stale。
export function readFxFreshness(
  cache: CacheStore,
  currencies: readonly string[],
): Promise<Map<string, CacheEntry>> {
  return cache.getMany(currencies.map((c) => cacheKeys.fx(c)));
}

// 一次批量写回。上游那个端点一把全给,所以这里恒是「十来个键一个批次」。
export function writeFx(
  cache: CacheStore,
  rates: readonly { currency: string; usdPerUnit: number }[],
): Promise<void> {
  return cache.putMany(
    rates.map((r) => ({ key: cacheKeys.fx(r.currency), value: r.usdPerUnit, ttlMs: FX_TTL_MS })),
  );
}

// 读一批平台缓存。**返回 `{name: null}` 与「键不在结果里」是两件事**:前者是「问过、上游没有」,
// 后者是「没问过」。`stale` 一并给出来 —— 预热据它决定要不要重拉,展示则一律用旧的。
export async function readPlatforms(
  cache: CacheStore,
  keys: readonly string[],
): Promise<Map<string, { entry: PlatformEntry; stale: boolean }>> {
  const hits = await cache.getMany(keys.map(cacheKeys.platform));
  const out = new Map<string, { entry: PlatformEntry; stale: boolean }>();
  for (const key of keys) {
    const hit = hits.get(cacheKeys.platform(key));
    const entry = hit?.value as PlatformEntry | undefined;
    if (!entry || !(typeof entry.name === "string" || entry.name === null)) continue;
    out.set(key, { entry, stale: hit?.stale ?? true });
  }
  return out;
}

// 一次批量写。命中写长 TTL(名与图近静态),否定写短 TTL(新链随时可能被收录)。
export function writePlatforms(
  cache: CacheStore,
  entries: readonly { key: string; entry: PlatformEntry }[],
): Promise<void> {
  return cache.putMany(
    entries.map(({ key, entry }) => ({
      key: cacheKeys.platform(key),
      value: entry,
      ttlMs: entry.name === null ? PLATFORM_NEG_TTL_MS : PLATFORM_TTL_MS,
    })),
  );
}

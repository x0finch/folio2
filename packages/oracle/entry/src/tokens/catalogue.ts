import type { UpstreamError } from "@folio/client-core";
import type { CacheStore, DbRequest } from "@folio/db";
import type { TokenMetaUpstream, UpstreamToken } from "@folio/oracle-basic";
import { DEFAULT_TOP_N, PRICE_TTL_MS, WARM_TTL_MS } from "@folio/oracle-basic";
import type { TokenUpstream } from "@folio/oracle-basic/ports";
import { Clock, Effect, Option } from "effect";
import { WARM_KEY, type WarmRow, warmBlob } from "./warm";

// 币目录 —— 用户**选币**时看到的东西:默认那一列(市值前 N)与搜索结果。
//
// 与 `./price` 的分界是「问的是谁」:那片问「**我的**这个币怎么样」(per-user 的行),
// 本片问「**世上**有哪些币」(与用户无关的公开目录,住 warm blob)。所以本片一个 store 都不碰,
// 只要 `CacheStore` + 上游。
//
// **`search` 是全服务唯一把上游错误交出去的方法。** 其余能力都有本地旧值可退,上游挂了就降级;
// 而搜索没有任何旧值,吞掉它只会让用户看着一个空列表以为「搜不到这个币」—— 那一档必须让
// 调用方知道(它自己决定怎么显示)。
export interface TokenCatalogue {
  // 选币橱窗:市值 top-N,走 warm blob(冷则预热一次;价旧了也刷 —— 用户在看)。
  topTokens(limit: number): Effect.Effect<UpstreamToken[], never, DbRequest>;
  // 按关键词搜币(用户选币)。恒回源 —— 结果与用户无关,边缘缓存管它。
  // **唯一会把上游错误交出去的方法**(见本接口开头那段)。
  search(query: string): Effect.Effect<UpstreamToken[], UpstreamError>;
  // 后台预热:目录超过 WARM_TTL_MS(一周)就整份刷一次,否则零请求。返回目录条数。
  // **唯一主动让目录跟上的那条路** —— 写路径按设计永不刷,橱窗只在用户打开下拉时才跑。
  // 调用方须把它放在 best-effort 的位置(同步后 `waitUntil`),别挂在任何人的关键路径上。
  refreshCatalogue(): Effect.Effect<number, never, DbRequest>;
}

// —— warm blob 的两个读者(第三个是候选源,在 ./candidates)——
// 三条判据为什么不同、为什么都落在 blob 自己的 `asOf` 上,见 ./warm 的开头。

/**
 * 橱窗读者(选币下拉的默认列)。**价旧了就刷** —— 用户正看着这些数字,而且是他自己点开的,
 * 这一趟网络他等得起。
 */
export const warmMarkets = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
): Effect.Effect<readonly WarmRow[], never, DbRequest> =>
  warmBlob(cache, upstream, topN, (blob, now) => now - blob.asOf > PRICE_TTL_MS);

/**
 * 预热读者(同步之后在后台跑)。**目录旧了就整份刷一次** —— 这是唯一一条「主动让目录跟上」的路。
 *
 * 为什么不能指望另外两个:候选源按设计永不刷(它在写路径上),橱窗只在用户打开选币下拉时才跑
 * —— 从不开下拉的用户,候选集会冻在第一次同步那一刻,此后新进前 1000 的币永远认不出来。
 *
 * 跑在同步后的 best-effort 预热里(`waitUntil`,吞错),所以这 4 次请求不在任何人的关键路径上。
 */
export const refreshWarmCatalogue = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
): Effect.Effect<readonly WarmRow[], never, DbRequest> =>
  warmBlob(cache, upstream, topN, (blob, now) => now - blob.asOf > WARM_TTL_MS);

/**
 * 预热那条路先问一句「够新吗」,**只看 blob 自己的 `asOf`,不解码整份目录**(FOL-83 第二轮)。
 *
 * 一周里 167 次答案都是「够新」,而为了这一个数把 1000 行逐字段过一遍 Schema,本机实测约 9ms
 * 解码 + 7ms 回收 —— 每天那条 `catalogue` 消息的一大半(免费计划一次调用 10ms)。判据与
 * `refreshWarmCatalogue` 同一个(`now - asOf > WARM_TTL_MS` 才算旧);不够新 / 没有 / 形状不对
 * (`asOf` 不是数、`rows` 不是数组)→ `none`,走原来那条完整的路(解码、回源、写回)。
 *
 * **与原来唯一的差别**:一份 `asOf` 够新、但某几行形状坏了的 blob,原来会被这一趟当 miss 重拉,
 * 现在留到它过期为止。它照样自愈 —— 真要读行的三个读者(mint 的候选源、选币下拉)每次都完整
 * 解码,解不动就当 miss 回源重写。返回的条数按 ref 去重,与 `dedupeByRef` 之后的长度同一个口径。
 */
const freshCatalogueSize = (
  cache: CacheStore,
  now: number,
): Effect.Effect<Option.Option<number>, never, DbRequest> =>
  Effect.map(cache.get(WARM_KEY), (hit) =>
    Option.flatMap(hit, ({ value }) => {
      const blob = value as { asOf?: unknown; rows?: unknown } | null;
      if (typeof blob?.asOf !== "number" || !Array.isArray(blob.rows)) return Option.none();
      if (now - blob.asOf > WARM_TTL_MS) return Option.none();
      const refs = new Set<unknown>();
      for (const row of blob.rows as { info?: { ref?: unknown } }[]) refs.add(row?.info?.ref);
      return Option.some(refs.size);
    }),
  );

// 市值升序取前 limit(无 rank 者垫底)。
export function topByRank(rows: readonly WarmRow[], limit: number): readonly WarmRow[] {
  const rank = (r: WarmRow) => r.price.marketCapRank ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

export const makeCatalogue = (cache: CacheStore, upstream: TokenUpstream): TokenCatalogue => {
  // 橱窗读者:价旧了就刷(用户点开下拉、正看着这些数字)。**候选源不走这条** ——
  // 它在写路径上,判据不同,见 ./candidates(#216)。
  const rows = warmMarkets(cache, upstream, DEFAULT_TOP_N);

  return {
    topTokens: (limit) =>
      Effect.map(rows, (all) =>
        topByRank(all, limit).map(
          (r): UpstreamToken => ({
            ref: r.info.ref,
            symbol: r.info.symbol,
            name: r.info.name,
            logo: r.info.logo,
            price: r.price,
          }),
        ),
      ),

    search: (query) => upstream.searchTokens(query),

    refreshCatalogue: () =>
      Effect.gen(function* () {
        const fresh = yield* freshCatalogueSize(cache, yield* Clock.currentTimeMillis);
        if (Option.isSome(fresh)) return fresh.value;
        return (yield* refreshWarmCatalogue(cache, upstream, DEFAULT_TOP_N)).length;
      }),
  };
};

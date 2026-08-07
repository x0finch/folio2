import type {
  CacheEntry,
  CacheStore,
  TokenCandidate,
  TokenMetaUpstream,
} from "@folio/oracle-basic";
import {
  FX_TTL_MS,
  normalizeSymbol,
  PLATFORM_NEG_TTL_MS,
  PLATFORM_TTL_MS,
  PRICE_TTL_MS,
  WARM_TTL_MS,
} from "@folio/oracle-basic";
import { Clock, Effect, Option, Schema } from "effect";
import { swr } from "./refresh";

// 参考层的三样缓存,一张 per-user 的 KV 表,**三种键**:
//   warm             市值前 N 名,整份一个 JSON blob
//   fx:<币种>        展示币种汇率
//   platform:<键>    链 ∪ 场馆的名与图
//
// (同一张表上还有第四种键 `defi-logo:<协议>`,但那不是参考层的东西 —— 它没有上游、不出网,
//  住在 app 的 `defi-logo-store.ts`。)
//
// 界线:**整份都要用 → JSON;只挑几行用 → 表**。warm 每次都是整份读(排行榜、symbol 候选都从它出),
// 所以是 blob;全局映射每次只挑那么几行,所以是表(ADR 0022)。
//
// symbol 消歧的候选**不单独存** —— 候选恒是 warm 集的子集,从同一个 blob 里筛就行。
// 整张表删空功能不坏,只是下一次访问要回一趟上游。
//
// 本文件的函数**收已解析好的服务对象**(`cache` / `upstream`),不从 context 取 —— 于是它们的
// `R` 是 `never`,服务的方法签名不会把自己的依赖漏给调用方。从 Tag 取服务只发生在 Layer 那一层。

export const cacheKeys = {
  warm: "warm",
  fx: (currency: string) => `fx:${currency.trim().toUpperCase()}`,
  platform: (key: string) => `platform:${key}`,
} as const;

// —— 缓存里存的形状,用 Schema 声明并**解码**,不是 `as` 断言 ——
//
// 这些 blob 是我们自己写进 D1 的,所以「形状不对」不是上游变了,而是**我们上一个版本写的旧形状**
// (或者手动改过库)。老代码为此手写了两处形状检查(`!Array.isArray(value.rows)`、
// `typeof entry.name === "string" || entry.name === null`),第三处(fx 的 number)靠 typeof —— 三种写法。
// 用 Schema 之后判据只有一处,而且**解不动就当 miss**:回源重写一份新形状,自愈。
// 断言的话旧形状会一路流到展示层,变成「某几行没有名字」这种查不出来的怪事。
const TokenPriceShape = Schema.Struct({
  unitPrice: Schema.Number,
  change24h: Schema.optional(Schema.Number),
  marketCapRank: Schema.optional(Schema.Number),
  asOf: Schema.Number,
});

// warm 里的 info 还没进库 → 没有内部 id、`ref` 必然非空(与 `UpstreamToken` 同源)。
// 也没有 `infoStale`:那是「库里那行该回源刷了吗」,而这份**就是**刚从上游拿的。
const WarmInfoShape = Schema.Struct({
  ref: Schema.String,
  symbol: Schema.String,
  name: Schema.String,
  logo: Schema.optional(Schema.String),
});

// warm blob:一次整份写、一次整份读。行的形状沿用现有 `putWarm` 的 `{ info, price }` 对。
const WarmBlobShape = Schema.Struct({
  asOf: Schema.Number,
  rows: Schema.Array(Schema.Struct({ info: WarmInfoShape, price: TokenPriceShape })),
});

export type WarmBlob = Schema.Schema.Type<typeof WarmBlobShape>;
export type WarmRow = WarmBlob["rows"][number];

const decodeWarm = Schema.decodeUnknownOption(WarmBlobShape);

// 平台缓存里存的一条。**`name: null` = 否定缓存** —— 问过上游、它的链表里没有这个键。
// 与「这条压根没有」必须分开:后者会让每一次预热都为了这一个键重拉整张链表。
const PlatformEntryShape = Schema.Struct({
  name: Schema.NullOr(Schema.String),
  logo: Schema.optional(Schema.String),
});
export type PlatformEntry = Schema.Schema.Type<typeof PlatformEntryShape>;
const decodePlatform = Schema.decodeUnknownOption(PlatformEntryShape);

const decodeNumber = Schema.decodeUnknownOption(Schema.Number);

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
// 认不出来。三条都不看缓存条目的 `stale`(store 过期不删),判据一律落在 blob 的 `asOf` 上。
const warmBlob = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
  isStale: (blob: WarmBlob, now: number) => boolean,
): Effect.Effect<readonly WarmRow[]> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const read = Effect.map(cache.get(cacheKeys.warm), (hit) =>
      // 没有 / 解不动 → 回源(躲不掉)
      Option.flatMap(hit, (entry) =>
        Option.map(decodeWarm(entry.value), (value) => ({ value, stale: isStale(value, now) })),
      ),
    );

    const fetch = Effect.map(upstream.fetchMarkets({ topN }), (tokens) =>
      Option.some<WarmBlob>({
        asOf: now,
        rows: tokens.map((t) => ({
          info: { symbol: t.symbol, name: t.name, logo: t.logo, ref: t.ref },
          price: t.price ?? { unitPrice: 0, asOf: now },
        })),
      }),
    );

    const blob = yield* read.pipe(
      swr("cache.warm", fetch, (value) =>
        // **一次整份写**,不是逐行 upsert —— 前 N 名是一个快照,逐行写会写出半新半旧的榜。
        cache.put(cacheKeys.warm, value, WARM_TTL_MS),
      ),
    );
    return dedupeByRef(Option.match(blob, { onNone: () => [], onSome: (b) => b.rows }));
  });

// 目录是一个**集合**:一个币一行。在**读**这一侧兜住,而不只是在上游那侧去重,有两个理由:
//   · 已经存进缓存的脏目录得治 —— 这份 blob 一周才刷一次,不然修完还要脏一周
//   · 三个读者(mint 的候选、选币下拉、搜索)一处覆盖,不用各防一遍
//
// 重复不是假想:上游的分页来自不同快照,同一个币会在两页各出现一次(见 coingecko adapter 的注释)。
// 后果都是静默的 —— 按 symbol 认币时它会跟**自己**比排名、永远碾压不了「次席」,于是那个币
// 认不出来;选币列表那边则是同一个 key 出现两次,React 卸载了却摘不干净 DOM,留下僵尸行。
function dedupeByRef(rows: readonly WarmRow[]): readonly WarmRow[] {
  const seen = new Set<string>();
  const out: WarmRow[] = [];
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
export const warmCatalogue = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
): Effect.Effect<readonly WarmRow[]> => warmBlob(cache, upstream, topN, () => false);

/**
 * 预热读者(同步之后在后台跑)。**目录旧了就整份刷一次** —— 这是唯一一条「主动让目录跟上」的路。
 *
 * 为什么不能指望前两个:`warmCatalogue` 按设计永不刷(它在写路径上),`warmMarkets` 只在用户
 * 打开选币下拉时才跑 —— 从不开下拉的用户,候选集会冻在第一次同步那一刻,此后新进前 1000 的币
 * 永远认不出来。
 *
 * 跑在同步后的 best-effort 预热里(`waitUntil`,吞错),所以这 4 次请求不在任何人的关键路径上。
 */
export const refreshCatalogue = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
): Effect.Effect<readonly WarmRow[]> =>
  warmBlob(cache, upstream, topN, (blob, now) => now - blob.asOf > WARM_TTL_MS);

/**
 * 橱窗读者(选币下拉的默认列)。**价旧了就刷** —— 用户正看着这些数字,而且是他自己点开的,
 * 这一趟网络他等得起。判据是 blob 的 `asOf`,与缓存条目的过期戳无关。
 */
export const warmMarkets = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
): Effect.Effect<readonly WarmRow[]> =>
  warmBlob(cache, upstream, topN, (blob, now) => now - blob.asOf > PRICE_TTL_MS);

// 市值升序取前 limit(无 rank 者垫底)。
export function topByRank(rows: readonly WarmRow[], limit: number): readonly WarmRow[] {
  const rank = (r: WarmRow) => r.price.marketCapRank ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

// 按 symbol 筛候选。**与排行榜同一份 rows** —— 候选不额外存一份。
export function candidatesBySymbol(rows: readonly WarmRow[], symbol: string): TokenCandidate[] {
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

export const readFx = (cache: CacheStore, currency: string): Effect.Effect<Option.Option<number>> =>
  Effect.map(cache.get(cacheKeys.fx(currency)), (hit) =>
    Option.flatMap(hit, (entry) => decodeNumber(entry.value)),
  );

// 一批币种的新鲜度(预热用):miss 的键不出现,命中的带 stale。
export const readFxFreshness = (
  cache: CacheStore,
  currencies: readonly string[],
): Effect.Effect<Map<string, CacheEntry>> => cache.getMany(currencies.map((c) => cacheKeys.fx(c)));

// 一次批量写回。上游那个端点一把全给,所以这里恒是「十来个键一个批次」。
export const writeFx = (
  cache: CacheStore,
  rates: readonly { currency: string; usdPerUnit: number }[],
): Effect.Effect<void> =>
  cache.putMany(
    rates.map((r) => ({ key: cacheKeys.fx(r.currency), value: r.usdPerUnit, ttlMs: FX_TTL_MS })),
  );

// 读一批平台缓存。**返回 `{name: null}` 与「键不在结果里」是两件事**:前者是「问过、上游没有」,
// 后者是「没问过」。`stale` 一并给出来 —— 预热据它决定要不要重拉,展示则一律用旧的。
export const readPlatforms = (
  cache: CacheStore,
  keys: readonly string[],
): Effect.Effect<Map<string, { entry: PlatformEntry; stale: boolean }>> =>
  Effect.map(cache.getMany(keys.map(cacheKeys.platform)), (hits) => {
    const out = new Map<string, { entry: PlatformEntry; stale: boolean }>();
    for (const key of keys) {
      const hit = hits.get(cacheKeys.platform(key));
      if (!hit) continue;
      const entry = decodePlatform(hit.value);
      if (Option.isNone(entry)) continue;
      out.set(key, { entry: entry.value, stale: hit.stale });
    }
    return out;
  });

// 一次批量写。命中写长 TTL(名与图近静态),否定写短 TTL(新链随时可能被收录)。
export const writePlatforms = (
  cache: CacheStore,
  entries: readonly { key: string; entry: PlatformEntry }[],
): Effect.Effect<void> =>
  cache.putMany(
    entries.map(({ key, entry }) => ({
      key: cacheKeys.platform(key),
      value: entry,
      ttlMs: entry.name === null ? PLATFORM_NEG_TTL_MS : PLATFORM_TTL_MS,
    })),
  );

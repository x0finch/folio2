import type { CacheStore, TokenMetaUpstream } from "@folio/oracle-basic";
import { WARM_TTL_MS } from "@folio/oracle-basic";
import { Clock, Effect, Option, Schema } from "effect";
import { swr } from "./swr";

// 市值前 N 名,**整份一个 JSON blob**,住 per-user 缓存表的 `warm` 键上。
//
// 界线:整份都要用 → JSON;只挑几行用 → 表。warm 每次都是整份读(排行榜、symbol 候选都从它出),
// 所以是 blob;全局映射每次只挑那么几行,所以是表(ADR 0022)。
// symbol 消歧的候选**不单独存** —— 候选恒是 warm 集的子集,从同一个 blob 里筛就行。
//
// **同一份 blob,三个读者,新鲜度判据不同**(#216)。里面那 8 个字段的寿命差三个数量级:
//   价 / 24h 涨跌  分钟级      ← 只有橱窗在乎
//   市值排名        天级
//   symbol / 名 / 图  几乎不变  ← 候选源只要这些
//
// blob 整份读整份写,所以**不能**让它整体按最短的那个刷 —— 那会让 mint(写路径、用户在等)
// 为了一份「哪个币叫 POL」的数据去等 4 次目录请求。判据因此从「缓存条目过没过期」挪到
// **blob 自己的 `asOf`** 上,由各读者按自己的容忍度判 —— 这就是 `isStale` 这个参数存在的理由。
// 三个读者各自住在用它的那个文件里:
//   `warmCatalogue`    候选源(mint 写路径)  见 candidates.ts —— 永不刷
//   `warmMarkets`      选币下拉(用户在等)   见 tokens.ts    —— 价旧了就刷
//   `refreshCatalogue` 同步后的后台预热      见 tokens.ts    —— 目录旧了就刷
// 三条都不看缓存条目的 `stale`(store 过期不删),判据一律落在 blob 的 `asOf` 上。
//
// 本文件的函数**收已解析好的服务对象**(`cache` / `upstream`),不从 context 取 —— 于是它们的
// `R` 是 `never`,服务的方法签名不会把自己的依赖漏给调用方。从 Tag 取服务只发生在 Layer 那一层。

export const WARM_KEY = "warm";

// —— 缓存里存的形状,用 Schema 声明并**解码**,不是 `as` 断言 ——
//
// 这些 blob 是我们自己写进 D1 的,所以「形状不对」不是上游变了,而是**我们上一个版本写的旧形状**
// (或者手动改过库)。老代码为此手写了两处形状检查(`!Array.isArray(value.rows)`、
// `typeof entry.name === "string" || entry.name === null`)—— 用 Schema 之后判据只有一处,
// 而且**解不动就当 miss**:回源重写一份新形状,自愈。
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

// warm blob:一次整份写、一次整份读。行的形状是 `{ info, price }` 对。
const WarmBlobShape = Schema.Struct({
  asOf: Schema.Number,
  rows: Schema.Array(Schema.Struct({ info: WarmInfoShape, price: TokenPriceShape })),
});

export type WarmBlob = Schema.Schema.Type<typeof WarmBlobShape>;
export type WarmRow = WarmBlob["rows"][number];

const decodeWarm = Schema.decodeUnknownOption(WarmBlobShape);

export const warmBlob = (
  cache: CacheStore,
  upstream: TokenMetaUpstream,
  topN: number,
  isStale: (blob: WarmBlob, now: number) => boolean,
): Effect.Effect<readonly WarmRow[]> =>
  Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;

    const read = Effect.map(cache.get(WARM_KEY), (hit) =>
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
        cache.put(WARM_KEY, value, WARM_TTL_MS),
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

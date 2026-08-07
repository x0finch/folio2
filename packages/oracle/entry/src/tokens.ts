import type { UpstreamError } from "@folio/client-core";
import type {
  TokenMetaUpstream,
  TokenPrice,
  TokenPricePoint,
  TokenRecord,
  TokenRecordPrice,
  TokenRef,
  UpstreamToken,
} from "@folio/oracle-basic";
import {
  DEFAULT_TOP_N,
  dayBucketOf,
  INFO_TTL_MS,
  MS_PER_DAY,
  normalizeSymbol,
  PRICE_TTL_MS,
  WARM_TTL_MS,
} from "@folio/oracle-basic";
import { CacheStore, TokenPriceStore, TokenStore, TokenUpstream } from "@folio/oracle-basic/ports";
import { Clock, Context, Effect, Layer, Option } from "effect";
import { degradeTo, logDegraded } from "./degrade";
import { swr } from "./refresh";
import { type WarmRow, warmBlob } from "./warm";

// 读路径。**没有「解析」这一步** —— 拿 token_id 直接取名字、图、现价、涨跌、市值排名。
// 「这是哪个币」在写路径(mint)就定死并冻进了快照,读的时候不再从 tokenRef 反推。
//
// 「上游认没认出来」不是一种状态:看 `TokenInfo.ref` 空不空(ADR 0021),行上没有孤儿标记、
// 没有复查时刻,也没有带数据源名字的字段。
//
// **现价有两个家**,这是明知接受的:持仓币的价在价 store(估值用,要能按 token 点查),
// 选币列表的价在 warm blob 里(橱窗用),两边可能差几分钟。
//
// **错误通道只有 `search` 是非 never 的**,这是本层的口径:凡是「本地有旧值可用」的能力,
// 上游挂了就降级(`degradeTo` 记一行、给旧值),因为让总额和曲线因一次 429 崩掉是更坏的结果;
// 而搜索没有任何本地旧值可退,吞掉它只会让用户看着一个空列表以为「搜不到这个币」——
// 那一档必须让调用方知道(它自己决定怎么显示)。
export interface RefreshStaleReport {
  // 写回了几条价 / 几条元信息。
  prices: number;
  infos: number;
  // 这一轮有没有因为上游挂了而少刷 —— 与「本来就没什么要刷」是两件事。
  degraded: boolean;
}

export interface TokenReader {
  // 富化:按内部 id 批量读整行(info + 价合并)。输入**不再需要** symbol 或 tokenRef。
  enrich(ids: readonly string[]): Effect.Effect<Map<string, TokenRecord>>;
  // 按主键读一行的上游图 URL(logo 代理端点用):源给的优先,没有就用连接器自带那张。
  logoUrlById(id: string): Effect.Effect<Option.Option<string>>;

  // 取单价:新鲜 → 直接回;stale/miss → 回源 → 写回。长尾币按需取价走这条。
  priceOf(tokenId: string): Effect.Effect<Option.Option<TokenRecordPrice>>;
  // 选币表单预填单价:按 ref 现取,**不建行、不写缓存**。
  //
  // 为什么不能走 `priceOf`:那个收的是内部 id,而用户此刻只是在下拉里点了一下 —— 按设计
  // 这一刻还不建行(他可能就把抽屉关了,留一堆没人要的代币行)。行是提交时才由 mint 建的。
  // 取不到(上游不认识 / 上游挂了)→ `none`,表单让用户自己填。
  priceByRef(ref: TokenRef): Effect.Effect<Option.Option<TokenPrice>>;
  // 选币下拉的 SWR 刷价:一批 ref 现取(`priceByRef` 的批量版)。同样**不建行、不写缓存** ——
  // 用户还在下拉里划,行只在提交时由 mint 建。上游失败 → 空 Map,那几行显示无价。
  pricesByRefs(refs: readonly TokenRef[]): Effect.Effect<Map<TokenRef, TokenPrice>>;
  // 后台预热:这批 token 里价 / 元信息 stale 或缺失的,各一次批量回源写回。
  //
  // **一个方法而不是两个**:所有调用点(同步后的 `warmHeldPrices`、客户端触发的刷价 server fn)
  // 都是成对调用,而两个方法各自开头都要 `store.getByIds(ids)` —— 同一批 id 的 D1 读必然发两次,
  // 又因为是并发调的,连「第二次碰巧命中」都不存在。合起来之后 store 读一次、价 store 读一次,
  // 价与 info 两条 fetch+write 分支再并发。
  //
  // 价与 info 仍是**两个上游端点、两套 TTL**(名与图近乎静态 30d,价 30min),只是共用那两次读。
  //
  // `degraded` = 这一轮有上游挂了(而不是「没什么要刷」)。`E` 仍是 `never` —— 调用方不被逼 catch,
  // 变化只是「挂了」从只进日志变成也进返回值,于是「连续几天暖不上价」有了抓手(#375)。
  refreshStale(ids: readonly string[]): Effect.Effect<RefreshStaleReport>;

  // 历史日价序列(#148 / ADR 0019):命中缓存的过去日直接用,缺的一次回源补齐并永久落缓存;
  // 今日桶恒现取(可变,不缓存)。上游失败 → 退回仅缓存(曲线不因缺价崩)。
  priceSeries(
    tokenId: string,
    fromMs: number,
    toMs: number,
  ): Effect.Effect<readonly TokenPricePoint[]>;
  // 某时刻的历史价:atMs 所属 UTC 日桶的价;该日无数据 → `none`(调用方降级)。
  priceAt(tokenId: string, atMs: number): Effect.Effect<Option.Option<number>>;

  // 选币橱窗:市值 top-N,走 warm blob(冷则预热一次;价旧了也刷 —— 用户在看)。
  topTokens(limit: number): Effect.Effect<UpstreamToken[]>;
  // 按关键词搜币(用户选币)。恒回源 —— 结果与用户无关,边缘缓存管它。
  // **唯一会把上游错误交出去的方法**(见本接口开头那段)。
  search(query: string): Effect.Effect<UpstreamToken[], UpstreamError>;

  // 后台预热:目录超过 WARM_TTL_MS(一周)就整份刷一次,否则零请求。返回目录条数。
  // **唯一主动让目录跟上的那条路** —— 写路径按设计永不刷,橱窗只在用户打开下拉时才跑。
  // 调用方须把它放在 best-effort 的位置(同步后 `waitUntil`),别挂在任何人的关键路径上。
  refreshCatalogue(): Effect.Effect<number>;
}

export const TokenReader = Context.GenericTag<TokenReader>("oracle/TokenReader");

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
): Effect.Effect<readonly WarmRow[]> =>
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
): Effect.Effect<readonly WarmRow[]> =>
  warmBlob(cache, upstream, topN, (blob, now) => now - blob.asOf > WARM_TTL_MS);

// 市值升序取前 limit(无 rank 者垫底)。
export function topByRank(rows: readonly WarmRow[], limit: number): readonly WarmRow[] {
  const rank = (r: WarmRow) => r.price.marketCapRank ?? Number.POSITIVE_INFINITY;
  return [...rows].sort((a, b) => rank(a) - rank(b)).slice(0, limit);
}

// **`now` 那个 config 字段没了** —— 时间从 `Clock` 取,测试用 `TestClock` 推。
// 判据是 CODING.md 那条:只有测试会传的字段,就不该是字段(它当初有 5 个默认值散在各处)。
const make = Effect.gen(function* () {
  const store = yield* TokenStore;
  const prices = yield* TokenPriceStore;
  const cache = yield* CacheStore;
  const upstream = yield* TokenUpstream;

  // 橱窗读者:价旧了就刷(用户点开下拉、正看着这些数字)。**候选源不走这条** ——
  // 它在写路径上,判据不同,见 ./candidates(#216)。
  const rows = warmMarkets(cache, upstream, DEFAULT_TOP_N);

  const priceSeries = (
    tokenId: string,
    fromMs: number,
    toMs: number,
  ): Effect.Effect<readonly TokenPricePoint[]> =>
    Effect.gen(function* () {
      const info = yield* store.getById(tokenId);
      // 上游还没认出它 → 取不到历史价(本源只认自己给的名字)。
      const ref = Option.flatMap(info, (i) => Option.fromNullable(i.ref));
      if (Option.isNone(ref) || fromMs > toMs) return [];

      const fromB = dayBucketOf(fromMs);
      const toB = dayBucketOf(toMs);
      const todayB = dayBucketOf(yield* Clock.currentTimeMillis);
      const buckets: number[] = [];
      for (let b = fromB; b <= toB; b++) buckets.push(b);

      const cached = yield* prices.getDaily(tokenId, buckets);
      const missingPast = buckets.filter((b) => b < todayB && !cached.has(b));
      const needsToday = toB >= todayB; // 今日桶恒现取(可变,不缓存)

      const fetched = new Map<number, number>();
      if (missingPast.length > 0 || needsToday) {
        const raw = yield* upstream
          .fetchPriceSeries(ref.value, fromMs, toMs)
          .pipe(degradeTo("tokens.priceSeries", [] as readonly TokenPricePoint[]));
        for (const pt of raw) fetched.set(dayBucketOf(pt.atMs), pt.unitPrice); // 升序 → 当日最后一点胜出

        const toPersist = [...fetched.entries()]
          .filter(([b]) => b < todayB && !cached.has(b)) // 只落不可变的过去日
          .map(([dayBucket, unitPrice]) => ({ dayBucket, unitPrice }));
        if (toPersist.length > 0) yield* prices.putDaily(tokenId, toPersist);
      }

      const out: TokenPricePoint[] = [];
      for (const b of buckets) {
        const price = cached.get(b) ?? fetched.get(b);
        if (typeof price === "number") out.push({ atMs: b * MS_PER_DAY, unitPrice: price });
      }
      return out;
    });

  // 一批 (ref → tokenId) 的价:回源 → 写回。返回写了几条 + 这一轮有没有降级。
  const refreshPrices = (
    byRef: Map<string, string>,
  ): Effect.Effect<{ written: number; degraded: boolean }> =>
    Effect.gen(function* () {
      if (byRef.size === 0) return { written: 0, degraded: false };
      const fetched = yield* Effect.either(upstream.fetchPrices([...byRef.keys()]));
      if (fetched._tag === "Left") {
        yield* logDegraded("tokens.refreshStale.prices", fetched.left);
        return { written: 0, degraded: true };
      }
      const writes = [...fetched.right.entries()]
        .map(([ref, price]) => {
          const tokenId = byRef.get(ref);
          // 上游回了我们没问的(或已被合并掉的)ref → 丢掉,别写野行。
          return tokenId ? { tokenId, ...price } : undefined;
        })
        .filter((w) => w !== undefined);
      if (writes.length > 0) yield* prices.put(writes, PRICE_TTL_MS);
      return { written: writes.length, degraded: false };
    });

  // 一批 (ref → tokenId) 的元信息:回源 → **覆盖**写回(上游是这三个字段的权威 home)。
  //
  // 为什么必须覆盖而不是填空槽:行是拿连接器报的元信息建的,而链上合约的 symbol 是部署者写在
  // 合约里的字符串 —— MATIC 改名 POL 之后链上那份还写着 MATIC。合约那条 ref 是**按地址**
  // 认出来的、认定可信,错的只是显示名。同一个币于是在链上侧显示 MATIC、在交易所侧显示 POL,
  // 而它们其实是同一行 —— 用户看到的名字取决于哪个账户先同步,这不该是随机的。
  const refreshInfos = (
    byRef: Map<string, string>,
  ): Effect.Effect<{ written: number; degraded: boolean }> =>
    Effect.gen(function* () {
      if (byRef.size === 0) return { written: 0, degraded: false };
      const fetched = yield* Effect.either(upstream.fetchTokens([...byRef.keys()]));
      if (fetched._tag === "Left") {
        yield* logDegraded("tokens.refreshStale.infos", fetched.left);
        return { written: 0, degraded: true };
      }
      const writes = fetched.right
        .map((t) => {
          const tokenId = byRef.get(t.ref);
          // 上游没收录的 ref 不在结果里;回来了却对不上我们要的键 → 丢掉,别乱写。
          //
          // **symbol 要归一。** 大小写是**我们**的展示口径,不是上游的 —— CoinGecko 给的是小写
          // (`usdc`),而建行那一侧是大写。不归一就出现「同一行刷一次变小写」:显示从 `USDC`
          // 跳成 `usdc`,而且 symbol 还是 symbol 消歧的比较键(见 candidatesBySymbol)。
          // 覆盖上游的**名字**是对的(MATIC→POL),但那是内容,大小写不是。
          return tokenId
            ? { tokenId, symbol: normalizeSymbol(t.symbol), name: t.name, logo: t.logo }
            : undefined;
        })
        .filter((w) => w !== undefined);
      if (writes.length > 0) yield* store.putInfo(writes, INFO_TTL_MS);
      return { written: writes.length, degraded: false };
    });

  const reader: TokenReader = {
    priceSeries,

    enrich: (ids) =>
      Effect.gen(function* () {
        if (ids.length === 0) return new Map<string, TokenRecord>();
        // 两个 store 各读自己那半,服务层合成整行 —— 这正是切开端口的用处。
        // 并发度写出来(以前是 `Promise.all` 的隐式「全都一起上」)。
        const [infos, priced] = yield* Effect.all([store.getByIds(ids), prices.getByIds(ids)], {
          concurrency: 2,
        });
        const out = new Map<string, TokenRecord>();
        for (const [id, info] of infos) out.set(id, { ...info, price: priced.get(id) });
        return out;
      }),

    logoUrlById: (id) =>
      Effect.map(store.getById(id), (info) =>
        Option.flatMap(info, (i) => Option.fromNullable(i.logo ?? i.providerLogo)),
      ),

    // 单个币的价走 SWR:新鲜直接回、stale 回源写回、上游没有则保留旧值。
    priceOf: (tokenId) => {
      const read = Effect.map(prices.getByIds([tokenId]), (hits) =>
        Option.map(Option.fromNullable(hits.get(tokenId)), (hit) => ({
          value: hit,
          stale: hit.stale,
        })),
      );
      const fetch = Effect.gen(function* () {
        const info = yield* store.getById(tokenId);
        const ref = Option.flatMap(info, (i) => Option.fromNullable(i.ref));
        if (Option.isNone(ref)) return Option.none<TokenRecordPrice>(); // 认不出来的币取不了价
        const got = yield* upstream.fetchPrices([ref.value]);
        return Option.map(Option.fromNullable(got.get(ref.value)), (p) => ({
          ...p,
          stale: false,
        }));
      });
      return read.pipe(
        swr("tokens.priceOf", fetch, (value) => prices.put([{ tokenId, ...value }], PRICE_TTL_MS)),
      );
    },

    priceByRef: (ref) =>
      upstream.fetchPrices([ref]).pipe(
        Effect.map((found) => Option.fromNullable(found.get(ref))),
        degradeTo("tokens.priceByRef", Option.none<TokenPrice>()),
      ),

    pricesByRefs: (refs) =>
      refs.length === 0
        ? Effect.succeed(new Map<TokenRef, TokenPrice>())
        : // upstream 已按 IDS_PER_REQUEST 分块(#245),这里整批交给它。
          upstream
            .fetchPrices(refs)
            .pipe(degradeTo("tokens.pricesByRefs", new Map<TokenRef, TokenPrice>())),

    refreshStale: (ids) =>
      Effect.gen(function* () {
        if (ids.length === 0) return { prices: 0, infos: 0, degraded: false };
        // 两次读,不是四次 —— 价那半与 info 那半共用它们。
        const [infos, priced] = yield* Effect.all([store.getByIds(ids), prices.getByIds(ids)], {
          concurrency: 2,
        });

        // 只刷「认得出来且价 stale/缺失」的。
        const priceTargets = new Map<string, string>();
        for (const [id, info] of infos) {
          const p = priced.get(id);
          if (p && !p.stale) continue;
          if (info.ref) priceTargets.set(info.ref, id);
        }

        // 元信息只刷「认得出来(ref 非空)且 info stale」的:认不出来的行没有上游名字可取,
        // 它显示连接器报的那份就是对的。
        const infoTargets = new Map<string, string>();
        for (const [id, info] of infos) {
          if (!info.infoStale || !info.ref) continue;
          infoTargets.set(info.ref, id);
        }

        // 两条分支并发。**各自的上游失败不拖垮对方** —— `Effect.either` 而不是 `degradeTo`:
        // 除了记一行,还要把「挂了」带回给调用方(见 `RefreshStaleReport.degraded`)。
        const [priceOutcome, infoOutcome] = yield* Effect.all(
          [refreshPrices(priceTargets), refreshInfos(infoTargets)],
          { concurrency: 2 },
        );
        return {
          prices: priceOutcome.written,
          infos: infoOutcome.written,
          degraded: priceOutcome.degraded || infoOutcome.degraded,
        };
      }),

    priceAt: (tokenId, atMs) =>
      Effect.map(
        Effect.suspend(() => priceSeries(tokenId, dayBucketOf(atMs) * MS_PER_DAY, atMs)),
        (series) => Option.fromNullable(series.at(-1)?.unitPrice),
      ),

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
      Effect.map(refreshWarmCatalogue(cache, upstream, DEFAULT_TOP_N), (all) => all.length),
  };

  return reader;
});

export const tokenReaderLayer: Layer.Layer<
  TokenReader,
  never,
  TokenStore | TokenPriceStore | CacheStore | TokenUpstream
> = Layer.effect(TokenReader, make);

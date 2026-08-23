import type { UpstreamError } from "@folio/client-core";
import { UpstreamUnavailableError } from "@folio/client-core";
import type {
  CacheEntry,
  CacheStore,
  FxUpstream,
  GlobalTokenRefIndexStore,
  PlatformMeta,
  PlatformUpstream,
  ProviderTokenSeed,
  TokenCandidate,
  TokenInfo,
  TokenInfoPatch,
  TokenInfoWrite,
  TokenPrice,
  TokenPricePoint,
  TokenPriceStore,
  TokenPriceWrite,
  TokenRecordPrice,
  TokenRef,
  TokenRefHit,
  TokenRefIndexRow,
  TokenStore,
  TokenUpstream,
  UpstreamToken,
} from "@folio/oracle-basic";
import * as Ports from "@folio/oracle-basic/ports";
import { parseTokenRef } from "@folio/oracle-ref";
import { Clock, Effect, HashMap, Layer, Logger, Option, TestClock, TestContext } from "effect";
import type { OraclePorts, OracleServices } from "../src";
import { GlobalRefIndexService, oracleLayer } from "../src";
import { FxService } from "../src/fx";
import { PlatformService } from "../src/platforms";
import { TokenService } from "../src/tokens";
import { CandidateSource } from "../src/tokens/candidates";

// 内存假实现 + **一份共用的测试装配**(下面的 `harness`)—— 各片的测试都注这一套。
//
// 之所以是内存而不是真 D1:oracle 这几片**一个字都不碰 schema**,契约本身在这里被钉死,
// 换真实现时对着它写。
//
// 注意假实现里也**没有任何数据源的名字** —— `fakeUpstream()` 的 id 是参数,默认 `"src"`。
// 服务层的测试因此连「上游是谁」都不知道,这正是 ADR 0023 要的。
//
// **时间不再是假实现上的一个 `now` 字段**:全部走 `Clock`,用例内部要推时间就
// `yield* TestClock.adjust(…)`。以前每个假实现各带一个可变的 `now`,测试要记得两处都改。
//
// **只有一条构造路**:所有测试都经 `harness.run` → Tag → Layer,也就是**生产走的那条**。
// PR #379 的复审里那条「两条构造路,其中一条零测试」在这里不成立。

const NOW0 = 1_700_000_000_000;
export const now0 = NOW0;

// —— per-user:代币行的 info facet + ref 行 ——
export interface FakeTokenStore extends TokenStore {
  readonly rows: Map<string, TokenInfo>;
  readonly refs: Map<TokenRef, string>;
  // 历史快照的 token_id —— merge 要把它们一并改指,测试据此验「身份可变、金额不变」。
  readonly snapshotTokenIds: string[];
  namer: string; // 判 `linked` 用:哪个命名者算「已认出」
}

export function fakeTokenStore(seed: TokenInfo[] = [], namer = "src"): FakeTokenStore {
  const rows = new Map<string, TokenInfo>(seed.map((r) => [r.id, r]));
  const refs = new Map<TokenRef, string>();
  const snapshotTokenIds: string[] = [];
  let seq = 0;

  const store: FakeTokenStore = {
    rows,
    refs,
    snapshotTokenIds,
    namer,

    findByRefs: (input) =>
      Effect.sync(() => {
        // linked = 这个 Token 已经有当前源的 ref 行(真实现里是一次 join)。
        const linked = new Set<string>();
        for (const [ref, id] of refs) if (ref.startsWith(`${store.namer}/`)) linked.add(id);

        const out = new Map<TokenRef, TokenRefHit>();
        for (const ref of input) {
          const tokenId = refs.get(ref);
          if (tokenId) out.set(ref, { tokenId, linked: linked.has(tokenId) });
        }
        return out;
      }),

    create: (s: ProviderTokenSeed, newRefs) =>
      Effect.sync(() => {
        // upsert-then-read:并发下别人可能已经建过了 → 先看这些 ref 有没有主。
        for (const ref of newRefs) {
          const existing = refs.get(ref);
          if (existing) {
            for (const r of newRefs) refs.set(r, existing);
            return existing;
          }
        }
        seq += 1;
        const id = `tk_${seq}`;
        // provider 的图落 providerLogo(备用槽);`logo` 是源那一槽,留给后补。
        // `ref` = 当前源对它的命名:建行时若挂了本源的 ref 就有,否则 null。
        const sourceRef = newRefs.find((r) => r.startsWith(`${store.namer}/`)) ?? null;
        rows.set(id, {
          id,
          ref: sourceRef,
          symbol: s.symbol,
          name: s.name ?? s.symbol,
          providerLogo: s.providerLogo,
          // 建行时就算「该刷了」—— 这一份是连接器报的,上游那份还没覆盖过(与 D1 实现同)。
          infoStale: true,
        });
        for (const ref of newRefs) refs.set(ref, id);
        return id;
      }),

    linkRef: (tokenId, ref) =>
      Effect.sync(() => {
        const existing = refs.get(ref);
        if (existing) return existing;
        refs.set(ref, tokenId);
        const row = rows.get(tokenId);
        if (row && ref.startsWith(`${store.namer}/`)) row.ref = ref;
        // 真加了一条 ref → info 标成该刷(契约在 stores.ts:这是改名的证据)。
        if (row) row.infoStale = true;
        return tokenId;
      }),

    merge: (from, into) =>
      Effect.sync(() => {
        for (const [ref, id] of refs) if (id === from) refs.set(ref, into);
        for (let i = 0; i < snapshotTokenIds.length; i++) {
          if (snapshotTokenIds[i] === from) snapshotTokenIds[i] = into;
        }
        const src = rows.get(from);
        const dst = rows.get(into);
        // 旧行的 provider 图是回退链的一档,别随行一起丢。
        if (src && dst && !dst.providerLogo && src.providerLogo) {
          dst.providerLogo = src.providerLogo;
        }
        // 赢家的 info 标成该刷 —— 会合并就说明至少有一边的名字与上游当前叫法不一致。
        if (dst) dst.infoStale = true;
        rows.delete(from);
      }),

    getByIds: (ids) =>
      Effect.sync(() => {
        const out = new Map<string, TokenInfo>();
        for (const id of ids) {
          const row = rows.get(id);
          if (row) out.set(id, { ...row });
        }
        return out;
      }),

    getById: (id) => Effect.sync(() => Option.fromNullable(rows.get(id)).pipe(Option.map(clone))),

    fillInfo: (tokenId, patch: TokenInfoPatch) =>
      Effect.sync(() => {
        const row = rows.get(tokenId);
        if (!row) return;
        // 只填空槽 —— 已有值的字段一律不动。
        if (!row.name && patch.name) row.name = patch.name;
        row.logo ??= patch.logo;
        row.providerLogo ??= patch.providerLogo;
      }),

    // **覆盖**(与 fillInfo 相反)。刷过之后 infoStale 落下 —— 测试据此验「不会每次都白刷」。
    putInfo: (writes: readonly TokenInfoWrite[]) =>
      Effect.sync(() => {
        for (const w of writes) {
          const row = rows.get(w.tokenId);
          if (!row) continue;
          row.symbol = w.symbol;
          row.name = w.name;
          if (w.logo !== undefined) row.logo = w.logo; // 上游没给图 → 保留原有的
          row.infoStale = false;
        }
      }),

    candidatesBySymbol: (symbol) =>
      Effect.sync(() => {
        const out: TokenCandidate[] = [];
        for (const row of rows.values()) {
          if (row.ref && row.symbol.toUpperCase() === symbol.toUpperCase()) {
            out.push({ ref: row.ref });
          }
        }
        return out;
      }),
  };
  return store;
}

const clone = (row: TokenInfo): TokenInfo => ({ ...row });

// —— per-user:价 facet + 历史日价 ——
export interface FakeTokenPriceStore extends TokenPriceStore {
  readonly current: Map<string, { price: TokenPrice; expiresAt: number }>;
  readonly daily: Map<string, Map<number, number>>;
  // 按 ref 直存的历史日价(与 `daily` 分开:那个键是 tokenId,这个键是 ref —— 真表里两者
  // 落的是同一张 token_daily_prices,但假实现按调用路径分桶,断言起来才看得清走了哪条)。
  readonly dailyByRef: Map<string, Map<number, number>>;
}

export function fakeTokenPriceStore(): FakeTokenPriceStore {
  const current = new Map<string, { price: TokenPrice; expiresAt: number }>();
  const daily = new Map<string, Map<number, number>>();
  const dailyByRef = new Map<string, Map<number, number>>();

  const readDaily = (
    bucket: Map<string, Map<number, number>>,
    key: string,
    days: readonly number[],
  ) =>
    Effect.sync(() => {
      const byDay = bucket.get(key);
      const out = new Map<number, number>();
      if (!byDay) return out;
      for (const b of days) {
        const v = byDay.get(b);
        if (v != null) out.set(b, v);
      }
      return out;
    });

  const writeDaily = (
    bucket: Map<string, Map<number, number>>,
    key: string,
    prices: readonly { dayBucket: number; unitPrice: number }[],
  ) =>
    Effect.sync(() => {
      const byDay = bucket.get(key) ?? new Map<number, number>();
      for (const p of prices) byDay.set(p.dayBucket, p.unitPrice);
      bucket.set(key, byDay);
    });

  return {
    current,
    daily,
    dailyByRef,

    getByIds: (ids) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        const out = new Map<string, TokenRecordPrice>();
        for (const id of ids) {
          const hit = current.get(id);
          // 过期不删,读出带 stale(SWR)。
          if (hit) out.set(id, { ...hit.price, stale: hit.expiresAt <= now });
        }
        return out;
      }),

    put: (writes: readonly TokenPriceWrite[], ttlMs) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        for (const w of writes) {
          const { tokenId, ...price } = w;
          current.set(tokenId, { price, expiresAt: now + ttlMs });
        }
      }),

    getDaily: (tokenId, dayBuckets) => readDaily(daily, tokenId, dayBuckets),
    putDaily: (tokenId, prices) => writeDaily(daily, tokenId, prices),
    getDailyByRef: (ref, dayBuckets) => readDaily(dailyByRef, ref, dayBuckets),
    putDailyByRef: (ref, prices) => writeDaily(dailyByRef, ref, prices),
  };
}

// —— 全局映射表 ——
export interface FakeGlobalRefIndexStore extends GlobalTokenRefIndexStore {
  // 测试用它直接塞一条映射(模拟 cron 刷完表)。**不暴露内部键格式** ——
  // 让测试自己拼键的话,键格式一改测试就静默失配(踩过一次)。
  // chainRef → 整条 upstreamRef(#228:值是整条,不是裸 id)。
  set(upstream: string, chainRef: string, upstreamRef: TokenRef): void;
  writes: number; // putAll 调用次数(验「整份写一次」而非逐行 upsert)
  lookups: number;
}

const idxKey = (upstream: string, chainRef: string) => `${upstream} ${chainRef}`;

export function fakeGlobalRefIndexStore(
  seed: Record<string, TokenRef> = {}, // chainRef → 整条 upstreamRef
  upstream = "src",
): FakeGlobalRefIndexStore {
  const map = new Map<string, TokenRef>();
  for (const [chainRef, upstreamRef] of Object.entries(seed)) {
    map.set(idxKey(upstream, chainRef), upstreamRef);
  }
  const refreshedAt = new Map<string, number>();

  const store: FakeGlobalRefIndexStore = {
    set(u, chainRef, upstreamRef) {
      map.set(idxKey(u, chainRef), upstreamRef);
    },
    writes: 0,
    lookups: 0,

    lookup: (u, chainRefs) =>
      Effect.sync(() => {
        store.lookups += 1;
        const out = new Map<TokenRef, TokenRef>();
        for (const chainRef of chainRefs) {
          const v = map.get(idxKey(u, chainRef));
          if (v) out.set(chainRef, v);
        }
        return out;
      }),

    putAll: (rows: readonly TokenRefIndexRow[], updatedAt) =>
      Effect.sync(() => {
        store.writes += 1;
        for (const r of rows) {
          // upstream 由整条 upstreamRef 解出(与真 store 拆列同理)。
          const parts = parseTokenRef(r.upstreamRef);
          if (parts.kind === "unknown") continue;
          map.set(idxKey(parts.namer, r.chainRef), r.upstreamRef);
          refreshedAt.set(parts.namer, updatedAt);
        }
        if (rows.length === 0) refreshedAt.set(upstream, updatedAt);
      }),

    refreshedAt: (u) => Effect.sync(() => Option.fromNullable(refreshedAt.get(u))),
  };
  return store;
}

// —— per-user KV 缓存 ——
interface FakeCacheStore extends CacheStore {
  readonly entries: Map<string, { value: unknown; expiresAt: number }>;
  writes: number; // 写**批次**数(不是键数)—— 「一个批次写回」那类断言看这个
  reads: number; // 读**往返**数 —— 「一次读拿全」那类断言看这个
}

function fakeCacheStore(): FakeCacheStore {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  const read = (key: string, now: number): CacheEntry | undefined => {
    const hit = entries.get(key);
    return hit ? { value: hit.value, stale: hit.expiresAt <= now } : undefined;
  };

  const store: FakeCacheStore = {
    entries,
    writes: 0,
    reads: 0,

    get: (key) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        store.reads += 1;
        return Option.fromNullable(read(key, now));
      }),

    // 一次往返 —— 真实现是一条 `WHERE k IN (…)`,所以这里也只记一次读。
    getMany: (keys) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        store.reads += 1;
        const out = new Map<string, CacheEntry>();
        for (const key of new Set(keys)) {
          const hit = read(key, now);
          if (hit) out.set(key, hit); // miss 的键不出现(契约如此)
        }
        return out;
      }),

    put: (key, value, ttlMs) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        store.writes += 1;
        entries.set(key, { value, expiresAt: now + ttlMs });
      }),

    // 一个批次 —— 真实现是一次 D1 `batch()`,所以 writes 只加一。
    putMany: (batch) =>
      Effect.map(Clock.currentTimeMillis, (now) => {
        if (batch.length === 0) return;
        store.writes += 1;
        for (const w of batch) entries.set(w.key, { value: w.value, expiresAt: now + w.ttlMs });
      }),
  };
  return store;
}

// —— 上游 ——
// 失败注入:把 `fail` 设成一个 `UpstreamError`,下一发(以及此后每一发)那个方法就以它失败 ——
// 测试因此能验「上游挂了怎么降级」,而且是**按类型**挂的,不是抛一个随便的 Error。
interface FakeUpstream extends TokenUpstream {
  readonly calls: string[];
  markets: UpstreamToken[];
  searchResults: UpstreamToken[];
  prices: Map<TokenRef, TokenPrice>;
  series: TokenPricePoint[]; // 缺省 vsCurrency(USD)的历史腿
  // 按 vsCurrency(大写)的历史腿 —— 法币历史反算取「BTC 在某币种下的价」时用(ADR 0026)。
  // 命中就用它,否则回退 `series`。
  seriesByVs: Map<string, TokenPricePoint[]>;
  globalRefIndex: { rows: TokenRefIndexRow[]; unmatchedPlatforms: string[]; skipped: number };
  fail: UpstreamError | undefined;
}

export const upstreamDown = (upstream = "src"): UpstreamError =>
  new UpstreamUnavailableError({ upstream, where: "/fake", status: 503 });

function fakeUpstream(id = "src"): FakeUpstream {
  const src: FakeUpstream = {
    id,
    calls: [],
    markets: [],
    searchResults: [],
    prices: new Map(),
    series: [],
    seriesByVs: new Map(),
    globalRefIndex: { rows: [], unmatchedPlatforms: [], skipped: 0 },
    fail: undefined,

    fetchMarkets: ({ topN }) => gate(src, `fetchMarkets:${topN}`, () => src.markets.slice(0, topN)),

    searchTokens: (query) => gate(src, `searchTokens:${query}`, () => src.searchResults),

    fetchPrices: (refs) =>
      gate(src, `fetchPrices:${refs.join(",")}`, () => {
        const out = new Map<TokenRef, TokenPrice>();
        for (const ref of refs) {
          const p = src.prices.get(ref);
          if (p) out.set(ref, p);
        }
        return out;
      }),

    // 上游没收录的 ref 不出现在结果里(契约如此)。
    fetchTokens: (refs) =>
      gate(src, `fetchTokens:${refs.join(",")}`, () =>
        src.markets.filter((t) => refs.includes(t.ref)),
      ),

    fetchPriceSeries: (ref, fromMs, toMs, vsCurrency = "usd") => {
      const vs = vsCurrency.toUpperCase();
      return gate(src, `fetchPriceSeries:${ref}:${vs}`, () => {
        const all = src.seriesByVs.get(vs) ?? src.series;
        return all.filter((p) => p.atMs >= fromMs && p.atMs <= toMs);
      });
    },

    fetchRefIndex: () => gate(src, "fetchRefIndex", () => src.globalRefIndex),
  };
  return src;
}

// 记一次调用,然后按 `fail` 决定成功还是失败。
const gate = <A>(
  src: { calls: string[]; fail: UpstreamError | undefined },
  call: string,
  value: () => A,
): Effect.Effect<A, UpstreamError> =>
  Effect.suspend(() => {
    src.calls.push(call);
    return src.fail ? Effect.fail(src.fail) : Effect.sync(value);
  });

// —— 汇率上游 ——
interface FakeFxUpstream extends FxUpstream {
  fetches: number;
  rates: Map<string, number>;
  fail: UpstreamError | undefined;
  readonly calls: string[];
}

function fakeFxUpstream(rates: Record<string, number> = {}, id = "src"): FakeFxUpstream {
  const src: FakeFxUpstream = {
    id,
    fetches: 0,
    calls: [],
    fail: undefined,
    rates: new Map(Object.entries(rates)),
    // 汇率的 BTC 反算基,也是 BTC 美元历史腿的缓存键(ADR 0026)。历史腿的取数走代币 upstream 的
    // fetchPriceSeries,不在 FxUpstream 上;这里只声明基。
    btcRef: `${id}/issued:bitcoin`,
    fetchRates: () =>
      gate(src, "fetchRates", () => {
        src.fetches += 1;
        return new Map(src.rates);
      }),
  };
  return src;
}

// —— 平台上游 ——
interface FakePlatformUpstream extends PlatformUpstream {
  fetches: number;
  chains: PlatformMeta[];
  fail: UpstreamError | undefined;
  readonly calls: string[];
}

function fakePlatformUpstream(chains: PlatformMeta[] = [], id = "src"): FakePlatformUpstream {
  const src: FakePlatformUpstream = {
    id,
    fetches: 0,
    calls: [],
    fail: undefined,
    chains,
    fetchChains: () =>
      gate(src, "fetchChains", () => {
        src.fetches += 1;
        return src.chains;
      }),
  };
  return src;
}

// —— 一份共用的测试装配 ——
//
// 每个测试文件抄一遍 `provide` 尾巴是本仓踩过的坑(有几个 client 的测试漏了 provide 限频档,
// 于是偷偷跑在共享游标那一档上、跨用例串味)。所以这里只有一个入口:
//
//   const h = harness();
//   const price = await h.run(Effect.flatMap(TokenService, (t) => t.priceOf("tk_1")));
//
// `run` 里做了三件事:provide 全部端口的假实现 + 四个真服务(三个 per-user + 全局维护) +
// `TestContext`(虚拟时钟),并把时钟拨到 `now0`(固定基准,日桶算得出确定的值)。
// `GlobalRefIndexService` 不进 `oracleLayer`,但 cron 用例也走这个 harness,所以这里一并装上。
// 日志也被收下来 —— **降级必须留痕**是这次迁移的一条设计(以前 6 处 `catch {}` 一行痕迹都没有),
// 而「留痕」只有能断言才算数。
interface LogEntry {
  level: string;
  message: string;
  annotations: Record<string, unknown>;
}

export interface Harness {
  readonly store: FakeTokenStore;
  readonly prices: FakeTokenPriceStore;
  readonly cache: FakeCacheStore;
  readonly globalRefIndex: FakeGlobalRefIndexStore;
  readonly upstream: FakeUpstream;
  readonly fxUpstream: FakeFxUpstream;
  readonly platformUpstream: FakePlatformUpstream;
  // 这一次 `run` 里落下的日志(按顺序)。
  readonly logs: LogEntry[];
  // 跑一个用了参考层的 effect。**测试与生产走同一条构造路**(Tag → Layer)。
  run<A, E>(
    effect: Effect.Effect<
      A,
      E,
      OraclePorts | OracleServices | GlobalRefIndexService | CandidateSource
    >,
  ): Promise<A>;
}

export interface HarnessOpts {
  seedRows?: TokenInfo[];
  namer?: string;
  globalRefIndexSeed?: Record<string, TokenRef>;
  rates?: Record<string, number>;
  chains?: PlatformMeta[];
  // symbol → 上游 id 的策展小表(`Namer.overrides`)。
  overrides?: Readonly<Record<string, string>>;
  // 顶掉真候选源(mint 的那一组用例要**数**它被问了几次 —— 「有没有走到 symbol 那一档」
  // 本身就是断言对象)。不给就用真的(读缓存目录)。
  candidates?: CandidateSource;
}

export function harness(opts: HarnessOpts = {}): Harness {
  const namer = opts.namer ?? "src";
  const store = fakeTokenStore(opts.seedRows, namer);
  const prices = fakeTokenPriceStore();
  const cache = fakeCacheStore();
  const globalRefIndex = fakeGlobalRefIndexStore(opts.globalRefIndexSeed, namer);
  const upstream = fakeUpstream(namer);
  const fxUpstream = fakeFxUpstream(opts.rates, namer);
  const platformUpstream = fakePlatformUpstream(opts.chains, namer);

  const logs: LogEntry[] = [];
  const logger = Logger.replace(
    Logger.defaultLogger,
    Logger.make(({ message, logLevel, annotations }) => {
      logs.push({
        level: logLevel.label,
        message: Array.isArray(message) ? message.map(String).join(" ") : String(message),
        annotations: Object.fromEntries(Array.from(HashMap.entries(annotations))),
      });
    }),
  );

  const ports = Layer.mergeAll(
    Layer.succeed(Ports.TokenStore, store),
    Layer.succeed(Ports.TokenPriceStore, prices),
    Layer.succeed(Ports.CacheStore, cache),
    Layer.succeed(Ports.GlobalTokenRefIndexStore, globalRefIndex),
    Layer.succeed(Ports.TokenUpstream, upstream),
    Layer.succeed(Ports.FxUpstream, fxUpstream),
    Layer.succeed(Ports.PlatformUpstream, platformUpstream),
    Layer.succeed(Ports.Namer, { id: namer, overrides: opts.overrides ?? {} }),
  );
  // `provideMerge` 而不是 `provide`:端口也一并透出去,于是用例既能拿服务、也能直接拿假端口
  // (`readPlatforms(h.cache, …)` 那类内部件的单测就是直接用假端口的)。
  // `CandidateSource.Default` 也透出来:它在 `oracleLayer` 里已被 `TokenService` 吃掉(装配点看不到
  // 它),但它自己有一组测试(「写路径到底会不会出网」),那组要能直接拿到这个服务。
  // 默认就用生产那个 `oracleLayer`(整体装配也因此被每个用例覆盖到)。只有当用例要顶掉候选源时
  // 才手工拼一遍三个服务 —— `oracleLayer` 已经把 `CandidateSource` 吃进去了(那是设计:装配点
  // 不该看见它),从外面 merge 一个同 Tag 的 layer 谁赢是含糊的,所以这一档明写。
  const services = opts.candidates
    ? Layer.mergeAll(
        Layer.provide(TokenService.Default, Layer.succeed(CandidateSource, opts.candidates)),
        FxService.Default,
        PlatformService.Default,
        GlobalRefIndexService.Default,
        Layer.succeed(CandidateSource, opts.candidates),
      )
    : Layer.mergeAll(oracleLayer, CandidateSource.Default, GlobalRefIndexService.Default);
  const everything = Layer.provideMerge(services, ports);

  return {
    store,
    prices,
    cache,
    globalRefIndex,
    upstream,
    fxUpstream,
    platformUpstream,
    logs,
    run: (effect) =>
      Effect.runPromise(
        // 起点拨到固定基准(日桶算得出确定的值);用例内部要推时间就 `yield* TestClock.adjust(…)`。
        Effect.zipRight(TestClock.setTime(NOW0), effect).pipe(
          Effect.provide(everything),
          Effect.provide(logger),
          Effect.provide(TestContext.TestContext),
        ),
      ),
  };
}

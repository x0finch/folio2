import { parseTokenRef } from "@folio/oracle-ref";
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
} from "../src";

// 内存假实现 —— 各片的测试都注这一套。
// 之所以是内存而不是真 D1:oracle 这几片**一个字都不碰 schema**(真表留到 expand 那一片),
// 老 oracle 还在用现有的表跑着,动一下 CI 就红。契约本身在这里被钉死,换真实现时对着它写。
//
// 注意假实现里也**没有任何数据源的名字** —— `fakeUpstream()` 的 id 是参数,默认 `"src"`。
// 服务层的测试因此连「上游是谁」都不知道,这正是 ADR 0023 要的。

const NOW0 = 1_700_000_000_000;

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

    async findByRefs(input) {
      // linked = 这个 Token 已经有当前源的 ref 行(真实现里是一次 join)。
      const linked = new Set<string>();
      for (const [ref, id] of refs) if (ref.startsWith(`${store.namer}/`)) linked.add(id);

      const out = new Map<TokenRef, TokenRefHit>();
      for (const ref of input) {
        const tokenId = refs.get(ref);
        if (tokenId) out.set(ref, { tokenId, linked: linked.has(tokenId) });
      }
      return out;
    },

    async create(s: ProviderTokenSeed, newRefs) {
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
    },

    async linkRef(tokenId, ref) {
      const existing = refs.get(ref);
      if (existing) return existing;
      refs.set(ref, tokenId);
      const row = rows.get(tokenId);
      if (row && ref.startsWith(`${store.namer}/`)) row.ref = ref;
      // 真加了一条 ref → info 标成该刷(契约在 stores.ts:这是改名的证据)。
      if (row) row.infoStale = true;
      return tokenId;
    },

    async merge(from, into) {
      for (const [ref, id] of refs) if (id === from) refs.set(ref, into);
      for (let i = 0; i < snapshotTokenIds.length; i++) {
        if (snapshotTokenIds[i] === from) snapshotTokenIds[i] = into;
      }
      const src = rows.get(from);
      const dst = rows.get(into);
      // 旧行的 provider 图是回退链的一档,别随行一起丢。
      if (src && dst && !dst.providerLogo && src.providerLogo) dst.providerLogo = src.providerLogo;
      // 赢家的 info 标成该刷 —— 会合并就说明至少有一边的名字与上游当前叫法不一致。
      if (dst) dst.infoStale = true;
      rows.delete(from);
    },

    async getByIds(ids) {
      const out = new Map<string, TokenInfo>();
      for (const id of ids) {
        const row = rows.get(id);
        if (row) out.set(id, { ...row });
      }
      return out;
    },

    async getById(id) {
      const row = rows.get(id);
      return row ? { ...row } : undefined;
    },

    async fillInfo(tokenId, patch: TokenInfoPatch) {
      const row = rows.get(tokenId);
      if (!row) return;
      // 只填空槽 —— 已有值的字段一律不动。
      if (!row.name && patch.name) row.name = patch.name;
      row.logo ??= patch.logo;
      row.providerLogo ??= patch.providerLogo;
    },

    // **覆盖**(与 fillInfo 相反)。刷过之后 infoStale 落下 —— 测试据此验「不会每次都白刷」。
    async putInfo(writes: readonly TokenInfoWrite[]) {
      for (const w of writes) {
        const row = rows.get(w.tokenId);
        if (!row) continue;
        row.symbol = w.symbol;
        row.name = w.name;
        if (w.logo !== undefined) row.logo = w.logo; // 上游没给图 → 保留原有的
        row.infoStale = false;
      }
    },

    async candidatesBySymbol(symbol) {
      const out: TokenCandidate[] = [];
      for (const row of rows.values()) {
        if (row.ref && row.symbol.toUpperCase() === symbol.toUpperCase())
          out.push({ ref: row.ref });
      }
      return out;
    },
  };
  return store;
}

// —— per-user:价 facet + 历史日价 ——
export interface FakeTokenPriceStore extends TokenPriceStore {
  readonly current: Map<string, { price: TokenPrice; expiresAt: number }>;
  readonly daily: Map<string, Map<number, number>>;
  // 按 ref 直存的历史日价(与 `daily` 分开:那个键是 tokenId,这个键是 ref —— 真表里两者
  // 落的是同一张 token_daily_prices,但假实现按调用路径分桶,断言起来才看得清走了哪条)。
  readonly dailyByRef: Map<string, Map<number, number>>;
  now: number;
}

export function fakeTokenPriceStore(): FakeTokenPriceStore {
  const current = new Map<string, { price: TokenPrice; expiresAt: number }>();
  const daily = new Map<string, Map<number, number>>();
  const dailyByRef = new Map<string, Map<number, number>>();
  const store: FakeTokenPriceStore = {
    current,
    daily,
    dailyByRef,
    now: NOW0,

    async getByIds(ids) {
      const out = new Map<string, TokenRecordPrice>();
      for (const id of ids) {
        const hit = current.get(id);
        // 过期不删,读出带 stale(SWR)。
        if (hit) out.set(id, { ...hit.price, stale: hit.expiresAt <= store.now });
      }
      return out;
    },

    async put(writes: readonly TokenPriceWrite[], ttlMs) {
      for (const w of writes) {
        const { tokenId, ...price } = w;
        current.set(tokenId, { price, expiresAt: store.now + ttlMs });
      }
    },

    async getDaily(tokenId, dayBuckets) {
      const byDay = daily.get(tokenId);
      const out = new Map<number, number>();
      if (!byDay) return out;
      for (const b of dayBuckets) {
        const v = byDay.get(b);
        if (v != null) out.set(b, v);
      }
      return out;
    },

    async putDaily(tokenId, prices) {
      const byDay = daily.get(tokenId) ?? new Map<number, number>();
      for (const p of prices) byDay.set(p.dayBucket, p.unitPrice);
      daily.set(tokenId, byDay);
    },

    async getDailyByRef(ref, dayBuckets) {
      const byDay = dailyByRef.get(ref);
      const out = new Map<number, number>();
      if (!byDay) return out;
      for (const b of dayBuckets) {
        const v = byDay.get(b);
        if (v != null) out.set(b, v);
      }
      return out;
    },

    async putDailyByRef(ref, prices) {
      const byDay = dailyByRef.get(ref) ?? new Map<number, number>();
      for (const p of prices) byDay.set(p.dayBucket, p.unitPrice);
      dailyByRef.set(ref, byDay);
    },
  };
  return store;
}

// —— 全局映射表 ——
export interface FakeRefIndexStore extends GlobalTokenRefIndexStore {
  // 测试用它直接塞一条映射(模拟 cron 刷完表)。**不暴露内部键格式** ——
  // 让测试自己拼键的话,键格式一改测试就静默失配(踩过一次)。
  // chainRef → 整条 upstreamRef(#228:值是整条,不是裸 id)。
  set(upstream: string, chainRef: string, upstreamRef: TokenRef): void;
  writes: number; // putAll 调用次数(验「整份写一次」而非逐行 upsert)
  lookups: number;
}

const idxKey = (upstream: string, chainRef: string) => `${upstream} ${chainRef}`;

export function fakeRefIndexStore(
  seed: Record<string, TokenRef> = {}, // chainRef → 整条 upstreamRef
  upstream = "src",
): FakeRefIndexStore {
  const map = new Map<string, TokenRef>();
  for (const [chainRef, upstreamRef] of Object.entries(seed)) {
    map.set(idxKey(upstream, chainRef), upstreamRef);
  }
  const refreshedAt = new Map<string, number>();

  const store: FakeRefIndexStore = {
    set(u, chainRef, upstreamRef) {
      map.set(idxKey(u, chainRef), upstreamRef);
    },
    writes: 0,
    lookups: 0,
    async lookup(u, chainRefs) {
      store.lookups += 1;
      const out = new Map<TokenRef, TokenRef>();
      for (const chainRef of chainRefs) {
        const v = map.get(idxKey(u, chainRef));
        if (v) out.set(chainRef, v);
      }
      return out;
    },
    async putAll(rows: readonly TokenRefIndexRow[], updatedAt) {
      store.writes += 1;
      for (const r of rows) {
        // upstream 由整条 upstreamRef 解出(与真 store 拆列同理)。
        const parts = parseTokenRef(r.upstreamRef);
        if (parts.kind === "unknown") continue;
        map.set(idxKey(parts.namer, r.chainRef), r.upstreamRef);
        refreshedAt.set(parts.namer, updatedAt);
      }
      if (rows.length === 0) refreshedAt.set(upstream, updatedAt);
    },
    async refreshedAt(u) {
      return refreshedAt.get(u) ?? null;
    },
  };
  return store;
}

// —— per-user KV 缓存 ——
export interface FakeCacheStore extends CacheStore {
  readonly entries: Map<string, { value: unknown; expiresAt: number }>;
  writes: number; // 写**批次**数(不是键数)—— 「一个批次写回」那类断言看这个
  reads: number; // 读**往返**数 —— 「一次读拿全」那类断言看这个
  now: number;
}

export function fakeCacheStore(): FakeCacheStore {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  const read = (key: string): CacheEntry | undefined => {
    const hit = entries.get(key);
    return hit ? { value: hit.value, stale: hit.expiresAt <= store.now } : undefined;
  };

  const store: FakeCacheStore = {
    entries,
    writes: 0,
    reads: 0,
    now: NOW0,
    async get(key) {
      store.reads += 1;
      return read(key);
    },
    // 一次往返 —— 真实现是一条 `WHERE k IN (…)`,所以这里也只记一次读。
    async getMany(keys) {
      store.reads += 1;
      const out = new Map<string, CacheEntry>();
      for (const key of new Set(keys)) {
        const hit = read(key);
        if (hit) out.set(key, hit); // miss 的键不出现(契约如此)
      }
      return out;
    },
    async put(key, value, ttlMs) {
      store.writes += 1;
      entries.set(key, { value, expiresAt: store.now + ttlMs });
    },
    // 一个批次 —— 真实现是一次 D1 `batch()`,所以 writes 只加一。
    async putMany(batch) {
      if (batch.length === 0) return;
      store.writes += 1;
      for (const w of batch) entries.set(w.key, { value: w.value, expiresAt: store.now + w.ttlMs });
    },
  };
  return store;
}

// —— 上游 ——
export interface FakeUpstream extends TokenUpstream {
  readonly calls: string[];
  markets: UpstreamToken[];
  searchResults: UpstreamToken[];
  prices: Map<TokenRef, TokenPrice>;
  series: TokenPricePoint[]; // 缺省 vsCurrency(USD)的历史腿
  // 按 vsCurrency(大写)的历史腿 —— 法币历史反算取「BTC 在某币种下的价」时用(ADR 0026)。
  // 命中就用它,否则回退 `series`。
  seriesByVs: Map<string, TokenPricePoint[]>;
  byContract: Map<string, UpstreamToken>;
  refIndex: { rows: TokenRefIndexRow[]; unmatchedPlatforms: string[]; skipped: number };
}

export function fakeUpstream(id = "src"): FakeUpstream {
  const src: FakeUpstream = {
    id,
    calls: [],
    markets: [],
    searchResults: [],
    prices: new Map(),
    series: [],
    seriesByVs: new Map(),
    byContract: new Map(),
    refIndex: { rows: [], unmatchedPlatforms: [], skipped: 0 },

    async fetchMarkets({ topN }) {
      src.calls.push(`fetchMarkets:${topN}`);
      return src.markets.slice(0, topN);
    },
    async searchTokens(query) {
      src.calls.push(`searchTokens:${query}`);
      return src.searchResults;
    },
    async fetchPrices(refs) {
      src.calls.push(`fetchPrices:${refs.join(",")}`);
      const out = new Map<TokenRef, TokenPrice>();
      for (const ref of refs) {
        const p = src.prices.get(ref);
        if (p) out.set(ref, p);
      }
      return out;
    },
    async fetchTokens(refs) {
      src.calls.push(`fetchTokens:${refs.join(",")}`);
      // 上游没收录的 ref 不出现在结果里(契约如此)。
      return src.markets.filter((t) => refs.includes(t.ref));
    },

    async fetchPriceSeries(ref, fromMs, toMs, vsCurrency = "usd") {
      const vs = vsCurrency.toUpperCase();
      src.calls.push(`fetchPriceSeries:${ref}:${vs}`);
      const all = src.seriesByVs.get(vs) ?? src.series;
      return all.filter((p) => p.atMs >= fromMs && p.atMs <= toMs);
    },
    async fetchByContract(chain, contract) {
      src.calls.push(`fetchByContract:${chain}:${contract}`);
      return src.byContract.get(`${chain}/${contract}`) ?? null;
    },
    async fetchRefIndex() {
      src.calls.push("fetchRefIndex");
      return src.refIndex;
    },
  };
  return src;
}

// —— 汇率上游 ——
export interface FakeFxUpstream extends FxUpstream {
  fetches: number;
  rates: Map<string, number>;
}

export function fakeFxUpstream(rates: Record<string, number> = {}, id = "src"): FakeFxUpstream {
  const src: FakeFxUpstream = {
    id,
    fetches: 0,
    rates: new Map(Object.entries(rates)),
    // 汇率的 BTC 反算基,也是 BTC 美元历史腿的缓存键(ADR 0026)。历史腿的取数走代币 upstream 的
    // fetchPriceSeries,不在 FxUpstream 上;这里只声明基。
    btcRef: `${id}/issued:bitcoin`,
    async fetchRates() {
      src.fetches += 1;
      return new Map(src.rates);
    },
  };
  return src;
}

// —— 平台上游 ——
export interface FakePlatformUpstream extends PlatformUpstream {
  fetches: number;
  chains: PlatformMeta[];
}

export function fakePlatformUpstream(
  chains: PlatformMeta[] = [],
  id = "src",
): FakePlatformUpstream {
  const src: FakePlatformUpstream = {
    id,
    fetches: 0,
    chains,
    async fetchChains() {
      src.fetches += 1;
      return src.chains;
    },
  };
  return src;
}

import type {
  CacheEntry,
  CacheStore,
  CgkRefRow,
  CgkRefStore,
  PricePoint,
  SourcePrice,
  SourceToken,
  Token,
  TokenInfoPatch,
  TokenPriceWrite,
  TokenRef,
  TokenSeed,
  TokenSource,
  TokenStore,
} from "../src";

// 内存假实现 —— 各片的测试都注这一套。
// 之所以是内存而不是真 D1:oracle2 这几片**一个字都不碰 schema**(真表留到 expand 那一片),
// 老 oracle 还在用现有的表跑着,动一下 CI 就红。契约本身在这里被钉死,换真实现时对着它写。

const now0 = 1_700_000_000_000;

// —— 代币表 ——
// 一行 = tokens 的一行;refs 是 token_refs(ref → tokenId)。真实现里两张表,这里一个 Map 够用。
export interface FakeTokenStore extends TokenStore {
  readonly rows: Map<string, Token>;
  readonly refs: Map<TokenRef, string>;
  readonly daily: Map<string, Map<number, number>>;
  // 历史快照的 token_id —— merge 要把它们一并改指,测试据此验「身份可变、金额不变」。
  readonly snapshotTokenIds: string[];
  now: number;
}

export function fakeTokenStore(seedRows: Token[] = []): FakeTokenStore {
  const rows = new Map<string, Token>(seedRows.map((r) => [r.id, r]));
  const refs = new Map<TokenRef, string>();
  const daily = new Map<string, Map<number, number>>();
  const snapshotTokenIds: string[] = [];
  let seq = 0;

  const store: FakeTokenStore = {
    rows,
    refs,
    daily,
    snapshotTokenIds,
    now: now0,

    async findByRefs(input) {
      const out = new Map<TokenRef, string>();
      for (const ref of input) {
        const id = refs.get(ref);
        if (id) out.set(ref, id);
      }
      return out;
    },

    async create(seed: TokenSeed, newRefs) {
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
      rows.set(id, { id, symbol: seed.symbol, name: seed.name ?? seed.symbol, logo: undefined });
      const row = rows.get(id);
      if (row && seed.logo) row.providerLogo = seed.logo;
      for (const ref of newRefs) refs.set(ref, id);
      return id;
    },

    async linkRef(tokenId, ref) {
      const existing = refs.get(ref);
      if (existing) return existing;
      refs.set(ref, tokenId);
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
      rows.delete(from);
      daily.delete(from);
    },

    async getByIds(ids) {
      const out = new Map<string, Token>();
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

    async listByRank(limit) {
      return [...rows.values()]
        .filter((r) => r.marketCapRank != null)
        .sort((a, b) => (a.marketCapRank ?? 0) - (b.marketCapRank ?? 0))
        .slice(0, limit)
        .map((r) => ({ ...r }));
    },

    async fillInfo(tokenId, patch: TokenInfoPatch) {
      const row = rows.get(tokenId);
      if (!row) return;
      // 只填空槽 —— 已有值的字段一律不动。
      row.name = row.name || (patch.name ?? row.name);
      row.logo ??= patch.logo;
      row.providerLogo ??= patch.providerLogo;
      row.marketCapRank ??= patch.marketCapRank;
    },

    async putPrices(prices: readonly TokenPriceWrite[]) {
      for (const p of prices) {
        const row = rows.get(p.tokenId);
        if (!row) continue;
        row.price = { unitPrice: p.unitPrice, change24h: p.change24h, asOf: p.asOf, stale: false };
        // 刷价只管价:排名归 warm / 解析写,这里有值才覆盖。
        if (p.marketCapRank != null) row.marketCapRank = p.marketCapRank;
      }
    },

    async getDailyPrices(tokenId, dayBuckets) {
      const byDay = daily.get(tokenId);
      const out = new Map<number, number>();
      if (!byDay) return out;
      for (const b of dayBuckets) {
        const v = byDay.get(b);
        if (v != null) out.set(b, v);
      }
      return out;
    },

    async putDailyPrices(tokenId, prices) {
      const byDay = daily.get(tokenId) ?? new Map<number, number>();
      for (const p of prices) byDay.set(p.dayBucket, p.unitPrice);
      daily.set(tokenId, byDay);
    },
  };
  return store;
}

// —— 全局 contract → coin 映射 ——
export interface FakeCgkRefStore extends CgkRefStore {
  readonly map: Map<TokenRef, string>;
  writes: number; // putAll 调用次数(验「整份写一次」而非逐行 upsert)
}

export function fakeCgkRefStore(seed: Record<string, string> = {}): FakeCgkRefStore {
  const map = new Map<TokenRef, string>(Object.entries(seed));
  let refreshedAt: number | null = null;
  const store: FakeCgkRefStore = {
    map,
    writes: 0,
    async lookup(refs) {
      const out = new Map<TokenRef, string>();
      for (const ref of refs) {
        const coinId = map.get(ref);
        if (coinId) out.set(ref, coinId);
      }
      return out;
    },
    async putAll(rows: readonly CgkRefRow[], updatedAt) {
      store.writes += 1;
      for (const r of rows) map.set(r.ref, r.coinId);
      refreshedAt = updatedAt;
    },
    async refreshedAt() {
      return refreshedAt;
    },
  };
  return store;
}

// —— per-user KV 缓存 ——
export interface FakeCacheStore extends CacheStore {
  readonly entries: Map<string, { value: unknown; expiresAt: number }>;
  writes: number;
  now: number;
}

export function fakeCacheStore(): FakeCacheStore {
  const entries = new Map<string, { value: unknown; expiresAt: number }>();
  const store: FakeCacheStore = {
    entries,
    writes: 0,
    now: now0,
    async get(key): Promise<CacheEntry | undefined> {
      const hit = entries.get(key);
      // 过期不删,读出带 stale(SWR)。
      return hit ? { value: hit.value, stale: hit.expiresAt <= store.now } : undefined;
    },
    async put(key, value, ttlMs) {
      store.writes += 1;
      entries.set(key, { value, expiresAt: store.now + ttlMs });
    },
  };
  return store;
}

// —— 上游 ——
export interface FakeSource extends TokenSource {
  readonly calls: string[];
  markets: SourceToken[];
  searchResults: SourceToken[];
  prices: Map<TokenRef, SourcePrice>;
  series: PricePoint[];
  byRef: Map<TokenRef, SourceToken>;
  refMap: { rows: CgkRefRow[]; unmatchedPlatforms: string[] };
}

export function fakeSource(namer = "coingecko"): FakeSource {
  const src: FakeSource = {
    namer,
    calls: [],
    markets: [],
    searchResults: [],
    prices: new Map(),
    series: [],
    byRef: new Map(),
    refMap: { rows: [], unmatchedPlatforms: [] },
    async fetchMarkets(topN) {
      src.calls.push(`fetchMarkets:${topN}`);
      return src.markets.slice(0, topN);
    },
    async searchTokens(query) {
      src.calls.push(`searchTokens:${query}`);
      return src.searchResults;
    },
    async fetchPrices(refs) {
      src.calls.push(`fetchPrices:${refs.join(",")}`);
      const out = new Map<TokenRef, SourcePrice>();
      for (const ref of refs) {
        const p = src.prices.get(ref);
        if (p) out.set(ref, p);
      }
      return out;
    },
    async fetchPriceSeries(ref, fromMs, toMs) {
      src.calls.push(`fetchPriceSeries:${ref}:${fromMs}:${toMs}`);
      return src.series.filter((p) => p.atMs >= fromMs && p.atMs <= toMs);
    },
    async fetchByRef(ref) {
      src.calls.push(`fetchByRef:${ref}`);
      return src.byRef.get(ref) ?? null;
    },
    async fetchRefMap() {
      src.calls.push("fetchRefMap");
      return src.refMap;
    },
  };
  return src;
}

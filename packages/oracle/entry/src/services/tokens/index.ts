import type {
  AssetRef,
  Resolution,
  ResolvableAsset,
  TokenInfo,
  TokenPrice,
  TokenPriceHistoryStore,
  TokenPricePoint,
  TokenRecord,
  TokenRef,
  TokenSource,
  TokenStore,
} from "@folio/oracle-basic";
import {
  dayBucketOf,
  MS_PER_DAY,
  OVERRIDES,
  PRICE_TTL_MS,
  TOKEN_REF_TTL_MS,
  vendorIdOf,
} from "@folio/oracle-basic";
import { tokenRef } from "@folio/oracle-ref";
import { createCoinGeckoSource } from "@folio/oracle-source-coingecko";
import { normalizeSymbol } from "./normalize";
import { type ResolveOpts, refreshWarm, resolveAsset } from "./service";

export interface CreateTokensConfig {
  apiKey?: string;
  // store 实现由调用方注入(D1 在 @folio/db,不该被 tokens 依赖);tokens 把 source.source(源标签)喂进来。
  createStore: (source: string) => TokenStore;
  // 历史日价缓存(#148 / ADR 0019)。可选:不传 → 无历史缓存(priceSeries/priceAt 每次现取、不落库,
  // 冷则空 → 调用方降级)。全局参考(无 userId,无 source 分桶,source 是列)→ 零参工厂。
  createPriceHistoryStore?: () => TokenPriceHistoryStore;
  // 默认 source = CoinGecko;测试可注入 stub。app 不传 → 用默认,不感知具体上游。
  source?: TokenSource;
}

// 无历史缓存时的空对象(降级):不读不写 → priceSeries 每次现取、不持久。
const NOOP_PRICE_HISTORY: TokenPriceHistoryStore = {
  getDailyPrices: async () => new Map(),
  putDailyPrices: async () => {},
};

// 单条富化结果(cache-only,扁平):ref=null 但仍可能有展示数据(provider 孤儿)。
// priceStale:有 ref 而价格过期/缺失(可后台刷新);孤儿无价不算 stale(无处可刷)。
export interface EnrichedAsset {
  ref: TokenRef | null;
  id?: string; // 内部代币行 id(在 store 才有;logo 代理端点的稳定 key,source 无关)
  name?: string;
  logo?: string; // canonical(CGK)
  providerLogo?: string; // provider 备用(展示回退链由调用方定序)
  unitPrice?: number;
  change24h?: number;
  marketCapRank?: number; // 市场数据(展示用:市值排名);孤儿/未收录为 undefined
  priceStale?: boolean;
}

// provider 采集入参(sync 后调用):可寻址的余额行 → seed/刷新代币表与实现索引。
// tokenId = 已构造的 CAIP-19 标识(合约形);调用方只传合约类(native/cgk 无需 seed)。
export interface ProviderAsset {
  tokenId: string;
  symbol: string;
  name?: string;
  logo?: string;
}

// tokens 对外的领域实例:只暴露意图方法,内部编排 source + store。调用方(app)不碰缓存/回源/写回、
// 不造 TokenRef、不感知具体 source(当前 CoinGecko)。
export interface Tokens {
  // 按关键词搜币。
  search(query: string): Promise<TokenInfo[]>;
  // 市值 top-N(默认选币列表)。空(未预热)→ 单飞预热一次再读。
  topTokens(limit: number): Promise<TokenInfo[]>;
  // 解析持仓身份 → 规范 ref。asset.identifier(用户显式选)由本层造 ref。
  resolve(asset: AssetRef, opts?: ResolveOpts): Promise<Resolution>;
  // 取单价:缓存新鲜 → 直接回;stale/miss → 回源 → 写回。
  priceOf(ref: TokenRef): Promise<TokenPrice | undefined>;
  // 历史日价序列(#148 / ADR 0019):一 ref 一区间,升序日价点(USD,atMs = UTC 日桶起点)。
  // 命中缓存的过去日直接用,缺的一次回源补齐并永久落缓存;今日桶恒现取(可变,不缓存)。
  // 非本源 / 无历史 / 上游失败 → 空(不抛,调用方降级)。
  priceSeries(ref: TokenRef, fromMs: number, toMs: number): Promise<TokenPricePoint[]>;
  // 某时刻的历史价(USD):atMs 所属 UTC 日桶的价;该日无数据 → undefined(调用方降级)。
  priceAt(ref: TokenRef, atMs: number): Promise<number | undefined>;
  // 展示富化(cache-only,零网络):tokenRef 优先(孤儿也出数据),否则 override/symbol 消歧。
  enrich(assets: readonly (AssetRef | null)[]): Promise<EnrichedAsset[]>;
  // 按内部代币行 id 取上游 logo URL(logo 代理端点用):source 无关,含孤儿 providerLogo;缺则 undefined。
  logoUrlById(id: string): Promise<string | undefined>;
  // 预热写缓存(best-effort):刷新 top-N warm,并对给定 assets 逐个 lazy 解析(触发升级合并)。
  warm(assets?: readonly (AssetRef | null)[]): Promise<void>;
  // provider 采集(sync 后):seed 孤儿 / 刷新 providerLogo(备用槽)。best-effort。
  noteProviderAssets(assets: readonly ProviderAsset[]): Promise<void>;
  // SWR 刷价:对给定 assets 解析出 ref 且价 stale/缺失者,一次批量回源写回。返回刷新条数。
  refreshStalePrices(assets: readonly (AssetRef | null)[]): Promise<number>;
}

// 冷缓存预热的进程内单飞(isolate 级):多个请求同时命中空 warm 时只发一次预热。
let warmInFlight: Promise<unknown> | null = null;

export function createTokens({
  apiKey,
  createStore,
  createPriceHistoryStore,
  source,
}: CreateTokensConfig): Tokens {
  const p = source ?? createCoinGeckoSource({ apiKey });
  const deps = { source: p, store: createStore(p.id), overrides: OVERRIDES };
  const history = createPriceHistoryStore ? createPriceHistoryStore() : NOOP_PRICE_HISTORY;

  // asset.identifier(用户显式选)→ 配上本源的命名者造 explicit ref。这是 `ref` 字段的**唯一**
  // 写入点,故它只存在于门面内部的 ResolvableAsset,不进公开的 AssetRef。
  const withExplicit = (asset: AssetRef): ResolvableAsset =>
    asset.identifier ? { ...asset, ref: tokenRef.issued(p.id, asset.identifier) } : asset;

  const resolve = (asset: AssetRef, opts?: ResolveOpts) =>
    resolveAsset(withExplicit(asset), deps, opts);

  const toEnriched = (ref: TokenRef | null, rec: TokenRecord | undefined): EnrichedAsset => ({
    ref,
    id: rec?.id,
    name: rec?.name,
    logo: rec?.logo,
    providerLogo: rec?.providerLogo,
    unitPrice: rec?.price?.unitPrice,
    change24h: rec?.price?.change24h,
    marketCapRank: rec?.marketCapRank,
    // 有 ref 才可刷:价缺失或过期均标 stale;孤儿(ref=null)无价不标(无处可刷)。
    priceStale: ref ? !rec?.price || rec.price.stale : false,
  });

  // cache-only 解析 + 记录读取:tokenRef 命中直接用整行(含孤儿);否则 explicit/override/symbol → getByRefs。
  // 返回与输入等长对齐的 (ref, record) 对。
  async function lookupAll(
    assets: readonly (AssetRef | null)[],
  ): Promise<{ ref: TokenRef | null; rec: TokenRecord | undefined }[]> {
    const withKeys = assets.map((a) => a?.tokenRef ?? null);
    const keys = [...new Set(withKeys.filter((k): k is string => k !== null))];
    const recordsByKey =
      keys.length > 0
        ? await deps.store.getByTokenRef(keys)
        : new Map<string, TokenRecord & { cgkCheckedUntil: number | null }>();

    // tokenRef 未命中(或无键)的走 explicit/override/symbol(cache-only)
    const rest: { i: number; asset: AssetRef }[] = [];
    const out: ({ ref: TokenRef | null; rec: TokenRecord | undefined } | null)[] = assets.map(
      (a, i) => {
        if (!a) return { ref: null, rec: undefined };
        const key = withKeys[i];
        const rec = key ? recordsByKey.get(key) : undefined;
        if (rec) return { ref: rec.ref, rec };
        rest.push({ i, asset: a });
        return null;
      },
    );
    const refs = await Promise.all(
      rest.map(async ({ asset }) => (await resolve(asset, { lazy: false })).ref),
    );
    const present = refs.filter((r): r is TokenRef => r !== null);
    const refMap =
      present.length > 0 ? await deps.store.getByRefs(present) : new Map<string, TokenRecord>();
    rest.forEach(({ i }, j) => {
      const ref = refs[j];
      out[i] = { ref, rec: ref ? refMap.get(ref) : undefined };
    });
    return out as { ref: TokenRef | null; rec: TokenRecord | undefined }[];
  }

  // 历史日价:读缓存日桶 → 缺的过去日一次回源补齐并永久落缓存 → 合并升序返回。
  // 今日桶恒需现取(可变,不落缓存)。上游失败 → 退回仅缓存(不抛,降级)。
  async function priceSeries(
    ref: TokenRef,
    fromMs: number,
    toMs: number,
  ): Promise<TokenPricePoint[]> {
    // 非本源命名的 ref(链上寻址等)拿不到历史价 —— 本源只认自己给的名字。
    if (!vendorIdOf(ref, deps.source.id) || fromMs > toMs) return [];
    const fromB = dayBucketOf(fromMs);
    const toB = dayBucketOf(toMs);
    const todayB = dayBucketOf(Date.now());
    const buckets: number[] = [];
    for (let b = fromB; b <= toB; b++) buckets.push(b);
    const cached = await history.getDailyPrices(ref, buckets);
    const missingPast = buckets.filter((b) => b < todayB && !cached.has(b));
    const needsToday = toB >= todayB; // 今日桶恒现取(不缓存)
    const fetched = new Map<number, number>();
    if (missingPast.length > 0 || needsToday) {
      try {
        const raw = await deps.source.fetchPriceSeries(ref, fromMs, toMs);
        for (const pt of raw) fetched.set(dayBucketOf(pt.atMs), pt.unitPrice); // 升序 → 当日最后一点胜出
      } catch {
        // 上游失败(限流/无历史/网络)→ 降级到仅缓存,不抛(曲线不因缺价崩)。
      }
      const toPersist = [...fetched.entries()]
        .filter(([b]) => b < todayB && !cached.has(b)) // 只落不可变的过去日,今日桶不缓存
        .map(([dayBucket, unitPrice]) => ({ dayBucket, unitPrice }));
      if (toPersist.length > 0) await history.putDailyPrices(ref, toPersist);
    }
    const out: TokenPricePoint[] = [];
    for (const b of buckets) {
      const price = cached.get(b) ?? fetched.get(b);
      if (typeof price === "number") out.push({ atMs: b * MS_PER_DAY, unitPrice: price });
    }
    return out;
  }

  async function priceAt(ref: TokenRef, atMs: number): Promise<number | undefined> {
    const dayStart = dayBucketOf(atMs) * MS_PER_DAY;
    const series = await priceSeries(ref, dayStart, atMs);
    return series.length > 0 ? series[series.length - 1].unitPrice : undefined;
  }

  return {
    resolve,
    priceSeries,
    priceAt,

    search: (query) => deps.source.searchTokens(query),

    async topTokens(limit) {
      const top = await deps.store.listTopTokens(limit);
      if (top.length > 0) return top;
      try {
        warmInFlight ??= refreshWarm(deps, { now: Date.now() }).finally(() => {
          warmInFlight = null;
        });
        await warmInFlight;
      } catch {
        // 预热失败(限流/网络)不阻断:返回当前(可能仍空),调用方降级。
      }
      return deps.store.listTopTokens(limit);
    },

    async priceOf(ref) {
      const rec = (await deps.store.getByRefs([ref])).get(ref);
      if (rec?.price && !rec.price.stale) {
        return {
          ref,
          unitPrice: rec.price.unitPrice,
          change24h: rec.price.change24h,
          marketCapRank: rec.marketCapRank,
          asOf: rec.price.asOf,
        };
      }
      const fetched = (await deps.source.fetchPrices([ref])).get(ref);
      if (fetched) await deps.store.putPrices([fetched], PRICE_TTL_MS);
      return fetched;
    },

    async enrich(assets) {
      const looked = await lookupAll(assets);
      return looked.map(({ ref, rec }) => toEnriched(ref, rec));
    },

    async logoUrlById(id) {
      const rec = await deps.store.getById(id);
      return rec?.logo ?? rec?.providerLogo;
    },

    async warm(assets) {
      try {
        await refreshWarm(deps, { now: Date.now() });
        for (const a of assets ?? []) if (a) await resolve(a, { lazy: true });
      } catch {
        // best-effort:预热失败不影响主流程,下次再试。
      }
    },

    async noteProviderAssets(assets) {
      for (const a of assets) {
        try {
          await deps.store.ensureTokenRef(
            a.tokenId,
            { symbol: normalizeSymbol(a.symbol), name: a.name, providerLogo: a.logo },
            TOKEN_REF_TTL_MS,
          );
        } catch {
          // best-effort:单条失败不阻断其余(下次 sync 重试)。
        }
      }
    },

    async refreshStalePrices(assets) {
      const looked = await lookupAll(assets);
      const stale = new Map<string, TokenRef>();
      for (const { ref, rec } of looked) {
        if (ref && (!rec?.price || rec.price.stale)) stale.set(ref, ref);
      }
      if (stale.size === 0) return 0;
      const fetched = await deps.source.fetchPrices([...stale.values()]);
      const prices = [...fetched.values()];
      if (prices.length > 0) await deps.store.putPrices(prices, PRICE_TTL_MS);
      return prices.length;
    },
  };
}

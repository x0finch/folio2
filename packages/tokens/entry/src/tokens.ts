import type {
  AssetRef,
  CgkCoinId,
  Resolution,
  TokenInfo,
  TokenPrice,
  TokenProvider,
  TokenRecord,
  TokenRef,
  TokenStore,
} from "@folio/tokens-basic";
import { OVERRIDES, PRICE_TTL_MS, refKey, TOKEN_KEY_TTL_MS } from "@folio/tokens-basic";
import { createCoinGeckoProvider } from "@folio/tokens-provider-coingecko";
import { normalizeSymbol } from "./normalize";
import { type ResolveOpts, refreshWarm, resolveAsset } from "./service";

export interface CreateTokensConfig {
  apiKey?: string;
  // store 实现由调用方注入(D1 在 @folio/db,不该被 tokens 依赖);tokens 把 provider.source 喂进来。
  createStore: (source: TokenRef["source"]) => TokenStore;
  // 默认 provider = CoinGecko;测试可注入 stub。app 不传 → 用默认,不感知具体上游。
  provider?: TokenProvider;
}

// 单条富化结果(cache-only,扁平):ref=null 但仍可能有展示数据(provider 孤儿)。
// priceStale:有 ref 而价格过期/缺失(可后台刷新);孤儿无价不算 stale(无处可刷)。
export interface EnrichedAsset {
  ref: TokenRef | null;
  name?: string;
  logo?: string; // canonical(CGK)
  providerLogo?: string; // provider 备用(展示回退链由调用方定序)
  unitPrice?: number;
  change24h?: number;
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

// tokens 对外的领域实例:只暴露意图方法,内部编排 provider + store。调用方(app)不碰缓存/回源/写回、
// 不造 TokenRef、不感知具体 provider/source。
export interface Tokens {
  // 按关键词搜币。
  search(query: string): Promise<TokenInfo[]>;
  // 市值 top-N(默认选币列表)。空(未预热)→ 单飞预热一次再读。
  topTokens(limit: number): Promise<TokenInfo[]>;
  // 解析持仓身份 → 规范 ref。asset.identifier(用户显式选)由本层造 ref。
  resolve(asset: AssetRef, opts?: ResolveOpts): Promise<Resolution>;
  // 取单价:缓存新鲜 → 直接回;stale/miss → 回源 → 写回。
  priceOf(ref: TokenRef): Promise<TokenPrice | undefined>;
  // 展示富化(cache-only,零网络):tokenKey 优先(孤儿也出数据),否则 override/symbol 消歧。
  enrich(assets: readonly (AssetRef | null)[]): Promise<EnrichedAsset[]>;
  // 预热写缓存(best-effort):刷新 top-N warm,并对给定 assets 逐个 lazy 解析(触发升级合并)。
  warm(assets?: readonly (AssetRef | null)[]): Promise<void>;
  // provider 采集(sync 后):seed 孤儿 / 刷新 providerLogo(备用槽)。best-effort。
  noteProviderAssets(assets: readonly ProviderAsset[]): Promise<void>;
  // SWR 刷价:对给定 assets 解析出 ref 且价 stale/缺失者,一次批量回源写回。返回刷新条数。
  refreshStalePrices(assets: readonly (AssetRef | null)[]): Promise<number>;
}

// 冷缓存预热的进程内单飞(isolate 级):多个请求同时命中空 warm 时只发一次预热。
let warmInFlight: Promise<unknown> | null = null;

export function createTokens({ apiKey, createStore, provider }: CreateTokensConfig): Tokens {
  const p = provider ?? createCoinGeckoProvider({ apiKey });
  const deps = { provider: p, store: createStore(p.source), overrides: OVERRIDES };

  // asset.identifier(用户显式选)→ explicit ref(用本 provider 的 source),调用方无需拼 TokenRef。
  const withExplicit = (asset: AssetRef): AssetRef =>
    asset.identifier && !asset.ref
      ? { ...asset, ref: { source: p.source, identifier: asset.identifier as CgkCoinId } }
      : asset;

  const resolve = (asset: AssetRef, opts?: ResolveOpts) =>
    resolveAsset(withExplicit(asset), deps, opts);

  const toEnriched = (ref: TokenRef | null, rec: TokenRecord | undefined): EnrichedAsset => ({
    ref,
    name: rec?.name,
    logo: rec?.logo,
    providerLogo: rec?.providerLogo,
    unitPrice: rec?.price?.unitPrice,
    change24h: rec?.price?.change24h,
    // 有 ref 才可刷:价缺失或过期均标 stale;孤儿(ref=null)无价不标(无处可刷)。
    priceStale: ref ? !rec?.price || rec.price.stale : false,
  });

  // cache-only 解析 + 记录读取:tokenKey 命中直接用整行(含孤儿);否则 explicit/override/symbol → getByRefs。
  // 返回与输入等长对齐的 (ref, record) 对。
  async function lookupAll(
    assets: readonly (AssetRef | null)[],
  ): Promise<{ ref: TokenRef | null; rec: TokenRecord | undefined }[]> {
    const withKeys = assets.map((a) => a?.tokenKey ?? null);
    const keys = [...new Set(withKeys.filter((k): k is string => k !== null))];
    const recordsByKey =
      keys.length > 0
        ? await deps.store.getByTokenKey(keys)
        : new Map<string, TokenRecord & { cgkCheckedUntil: number | null }>();

    // tokenKey 未命中(或无键)的走 explicit/override/symbol(cache-only)
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
      out[i] = { ref, rec: ref ? refMap.get(refKey(ref)) : undefined };
    });
    return out as { ref: TokenRef | null; rec: TokenRecord | undefined }[];
  }

  return {
    resolve,

    search: (query) => deps.provider.searchTokens(query),

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
      const rec = (await deps.store.getByRefs([ref])).get(refKey(ref));
      if (rec?.price && !rec.price.stale) {
        return {
          ref,
          unitPrice: rec.price.unitPrice,
          change24h: rec.price.change24h,
          marketCapRank: rec.marketCapRank,
          asOf: rec.price.asOf,
        };
      }
      const fetched = (await deps.provider.fetchPrices([ref])).get(refKey(ref));
      if (fetched) await deps.store.putPrices([fetched], PRICE_TTL_MS);
      return fetched;
    },

    async enrich(assets) {
      const looked = await lookupAll(assets);
      return looked.map(({ ref, rec }) => toEnriched(ref, rec));
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
          await deps.store.ensureTokenKey(
            a.tokenId,
            { symbol: normalizeSymbol(a.symbol), name: a.name, providerLogo: a.logo },
            TOKEN_KEY_TTL_MS,
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
        if (ref && (!rec?.price || rec.price.stale)) stale.set(refKey(ref), ref);
      }
      if (stale.size === 0) return 0;
      const fetched = await deps.provider.fetchPrices([...stale.values()]);
      const prices = [...fetched.values()];
      if (prices.length > 0) await deps.store.putPrices(prices, PRICE_TTL_MS);
      return prices.length;
    },
  };
}

import type {
  AssetRef,
  PriceSource,
  Resolution,
  TokenGroup,
  TokenInfo,
  TokenPrice,
  TokenRecord,
  TokenRef,
  TokenSource,
  TokenStore,
} from "@folio/oracle-basic";
import {
  INFO_TTL_MS,
  OVERRIDES,
  PRICE_TTL_MS,
  parseTokenKey,
  refKey,
  TOKEN_KEY_TTL_MS,
} from "@folio/oracle-basic";
import { createCoinGeckoSource } from "@folio/oracle-source-coingecko";
import { normalizeSymbol } from "./normalize";
import { type ResolveOpts, refreshWarm, resolveAsset } from "./service";

export interface CreateTokensConfig {
  apiKey?: string;
  // store 实现由调用方注入(D1 在 @folio/db,不该被 tokens 依赖);tokens 把 source.source(源标签)喂进来。
  createStore: (source: TokenRef["source"]) => TokenStore;
  // meta 源(身份/目录/搜索/解析权威):默认 CoinGecko;测试可注入 stub。app 不传 → 用默认。
  source?: TokenSource;
  // 活跃价源(用户所选,#93):缺省 = meta 自己的价面 → 单源(行为同旧)。当注入一个不同 source 的价源
  //(如 DefiLlama)→ 进【双源】:meta 仍供身份/元信息/解析,取价与读价改走活跃源(其 store 分桶那格)。
  // 合约币走活跃源的合约寻址(fetchByContract→link 落该源那格价);native/无合约回退 meta(baseline)价面。
  priceSource?: PriceSource;
}

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
  priceStale?: boolean;
  group?: TokenGroup; // 展示分组(P2):命中种子的 cgk 行才有;聚合按它归组
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
// 不造 TokenRef、不感知具体 source(coingecko/defillama)。
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
  source,
  priceSource,
}: CreateTokensConfig): Tokens {
  const meta = source ?? createCoinGeckoSource({ apiKey });
  const store = createStore(meta.source);
  const deps = { source: meta, store, overrides: OVERRIDES };

  // 活跃价源(#93):缺省 = meta 的价面(单源,行为同旧);注入了不同 source 的价源 → 双源。
  const price: PriceSource = priceSource ?? meta;
  const dual = price.source !== meta.source;
  // 双源时活跃源的 store(按其 source 分桶),读/写活跃源那格价;单源时就是 meta 的 store。
  const priceStore = dual ? createStore(price.source) : store;
  const TTLS = { indexTtlMs: TOKEN_KEY_TTL_MS, infoTtlMs: INFO_TTL_MS, priceTtlMs: PRICE_TTL_MS };

  // 合约币判定(双源取价寻址用):tokenKey 解出链+合约 → 可经活跃源合约寻址(fetchByContract)。
  // 与 ref 无关 —— 孤儿(CGK 未收录)也可有合约,正是活跃源(DefiLlama 链上价)的用武之地。
  const contractOf = (tokenKey?: string): { chainRef: string; contract: string } | undefined => {
    if (!tokenKey) return undefined;
    const p = parseTokenKey(tokenKey);
    return p.contract && p.chainRef ? { chainRef: p.chainRef, contract: p.contract } : undefined;
  };

  // asset.identifier(用户显式选)→ explicit ref(用 meta 的 source 标签),调用方无需拼 TokenRef。
  const withExplicit = (asset: AssetRef): AssetRef =>
    asset.identifier && !asset.ref
      ? // source↔identifier 品牌对齐由 meta 源保证 → 整体 as TokenRef(可信边界)。
        { ...asset, ref: { source: meta.source, identifier: asset.identifier } as TokenRef }
      : asset;

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
    // 有 ref 才可刷:价缺失或过期均标 stale;孤儿(ref=null)无价不标(无处可刷)。
    priceStale: ref ? !rec?.price || rec.price.stale : false,
    group: rec?.group,
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
      const rec = (await store.getByRefs([ref])).get(refKey(ref));
      // 双源:优先活跃源那格的新鲜价(按内部 id 读);否则回退 baseline。priceOf 面向【显式选币】
      // (通常无合约上下文)→ 活跃源没缓存就不合约寻址,直接用 baseline fetch 兜底。
      if (dual) {
        // 活跃源那格新鲜价优先(按内部 id 读)。
        const ap = rec?.id ? (await priceStore.getPricesByIds([rec.id])).get(rec.id) : undefined;
        if (ap && !ap.stale) {
          return {
            ref,
            unitPrice: ap.unitPrice,
            change24h: ap.change24h,
            marketCapRank: rec?.marketCapRank,
            asOf: ap.asOf,
          };
        }
      }
      // 新鲜 baseline 缓存短路(单源与双源共用):活跃源无新鲜价时也别每次网络取(否则 sync 逐笔打限流)。
      // priceOf 面向【显式选币】(无合约上下文,不做活跃源合约寻址);缓存皆 stale/缺才回源 baseline。
      if (rec?.price && !rec.price.stale) {
        return {
          ref,
          unitPrice: rec.price.unitPrice,
          change24h: rec.price.change24h,
          marketCapRank: rec.marketCapRank,
          asOf: rec.price.asOf,
        };
      }
      const fetched = (await meta.fetchPrices([ref])).get(refKey(ref));
      if (fetched) await store.putPrices([fetched], PRICE_TTL_MS);
      return fetched;
    },

    async enrich(assets) {
      const looked = await lookupAll(assets);
      if (!dual) return looked.map(({ ref, rec }) => toEnriched(ref, rec));
      // 双源 overlay(#93):合约币的目标格是【活跃源】那格 —— 有则覆盖价 + 用其 staleness;无则用 baseline 价
      // 兜底但**标 priceStale=true**,好让 SWR(pricesStale)触发 refreshStalePrices 去活跃源取价(否则
      // baseline 新鲜时永不刷、换源永不生效)。native/无合约币目标格是 baseline → 原样(其自身 staleness)。
      const ids = looked.map((l) => l.rec?.id).filter((x): x is string => !!x);
      const active = ids.length > 0 ? await priceStore.getPricesByIds(ids) : new Map();
      return looked.map(({ ref, rec }, i) => {
        const base = toEnriched(ref, rec);
        if (!contractOf(assets[i]?.tokenKey)) return base; // native/无合约:baseline 那格
        const ap = rec?.id ? active.get(rec.id) : undefined;
        return ap
          ? { ...base, unitPrice: ap.unitPrice, change24h: ap.change24h, priceStale: ap.stale }
          : { ...base, priceStale: true }; // 活跃源尚无价 → 兜底 baseline 价 + 标 stale 触发刷新
      });
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

      if (!dual) {
        const stale = new Map<string, TokenRef>();
        for (const { ref, rec } of looked) {
          if (ref && (!rec?.price || rec.price.stale)) stale.set(refKey(ref), ref);
        }
        if (stale.size === 0) return 0;
        const fetched = await meta.fetchPrices([...stale.values()]);
        const prices = [...fetched.values()];
        if (prices.length > 0) await store.putPrices(prices, PRICE_TTL_MS);
        return prices.length;
      }

      // 双源:目标格按币型分派 —— 合约币(含 CGK 未收录的孤儿)目标是【活跃源】那格(缺/过期 → 活跃源
      // 合约寻址取价并 link 落该源那格);native/无合约(有 ref)目标是【baseline】那格(缺/过期 → CGK 刷)。
      const ids = looked.map((l) => l.rec?.id).filter((x): x is string => !!x);
      const active = ids.length > 0 ? await priceStore.getPricesByIds(ids) : new Map();
      // 按 tokenKey 去重(同一合约跨多账户只取一次);value 带 ref(可空 = 孤儿)供取价失败时回退判定。
      const contractByKey = new Map<
        string,
        { chainRef: string; contract: string; ref: TokenRef | null }
      >();
      const baselineStale = new Map<string, TokenRef>();
      looked.forEach(({ ref, rec }, i) => {
        const key = assets[i]?.tokenKey;
        const c = contractOf(key);
        if (c && key) {
          // 合约币(ref 有无皆可 —— 孤儿正是活跃源的用武之地):活跃源那格缺/过期才取。
          const ap = rec?.id ? active.get(rec.id) : undefined;
          if (!ap || ap.stale) contractByKey.set(key, { ...c, ref });
        } else if (ref && (!rec?.price || rec.price.stale)) {
          baselineStale.set(refKey(ref), ref);
        }
      });

      let n = 0;
      // 活跃源合约取价 → link 落活跃源那格(建映射 + 写价;身份/元信息不动,baseline 权威)。
      const fetches = [...contractByKey.entries()];
      const results = await Promise.all(
        fetches.map(([key, f]) =>
          price.fetchByContract(f.chainRef, f.contract).then((res) => ({ key, f, res })),
        ),
      );
      for (const { key, f, res } of results) {
        if (res) {
          await priceStore.linkTokenKeyToCgk(key, res.info, res.price, TTLS);
          n++;
        } else if (f.ref) {
          // 活跃源未覆盖该合约币 → 回退刷 baseline(CGK 那格),别让它永远停在过期价。
          baselineStale.set(refKey(f.ref), f.ref);
        }
      }
      // baseline 长尾刷价(native/无合约 + 活跃源未覆盖的合约币,回退 CGK)。
      if (baselineStale.size > 0) {
        const fetched = await meta.fetchPrices([...baselineStale.values()]);
        const prices = [...fetched.values()];
        if (prices.length > 0) {
          await store.putPrices(prices, PRICE_TTL_MS);
          n += prices.length;
        }
      }
      return n;
    },
  };
}

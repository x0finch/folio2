import type {
  AssetRef,
  Resolution,
  TokenIdentifier,
  TokenInfo,
  TokenPrice,
  TokenProvider,
  TokenRef,
  TokenStore,
} from "@folio/tokens-basic";
import { OVERRIDES, PRICE_TTL_MS, refKey } from "@folio/tokens-basic";
import { createCoinGeckoProvider } from "@folio/tokens-provider-coingecko";
import { type ResolveOpts, refreshWarm, resolveAsset } from "./service";

export interface CreateTokensConfig {
  apiKey?: string;
  // store 实现由调用方注入(D1 在 @folio/db,不该被 tokens 依赖);tokens 把 provider.source 喂进来。
  createStore: (source: TokenRef["source"]) => TokenStore;
  // 默认 provider = CoinGecko;测试可注入 stub。app 不传 → 用默认,不感知具体上游。
  provider?: TokenProvider;
}

// 单条富化结果(cache-only):按输入 asset 顺序对齐。
export interface EnrichedAsset {
  ref: TokenRef | null;
  info?: TokenInfo;
  price?: TokenPrice;
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
  // 取单价:缓存优先 → miss 回源 → 写回缓存。
  priceOf(ref: TokenRef): Promise<TokenPrice | undefined>;
  // 展示富化(cache-only):对每个 asset 解析 + 批量取 info/price,按输入顺序返回(null 输入 → {ref:null})。
  enrich(assets: readonly (AssetRef | null)[]): Promise<EnrichedAsset[]>;
  // 预热写缓存(best-effort):刷新 top-N warm,并对给定 assets 逐个 lazy 解析(触发合约懒解析入缓存)。
  warm(assets?: readonly (AssetRef | null)[]): Promise<void>;
}

// 冷缓存预热的进程内单飞(isolate 级):多个请求同时命中空 warm 时只发一次预热。
let warmInFlight: Promise<unknown> | null = null;

export function createTokens({ apiKey, createStore, provider }: CreateTokensConfig): Tokens {
  const p = provider ?? createCoinGeckoProvider({ apiKey });
  const deps = { provider: p, store: createStore(p.source), overrides: OVERRIDES };

  // asset.identifier(用户显式选)→ explicit ref(用本 provider 的 source),调用方无需拼 TokenRef。
  const withExplicit = (asset: AssetRef): AssetRef =>
    asset.identifier && !asset.ref
      ? { ...asset, ref: { source: p.source, identifier: asset.identifier as TokenIdentifier } }
      : asset;

  const resolve = (asset: AssetRef, opts?: ResolveOpts) =>
    resolveAsset(withExplicit(asset), deps, opts);

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
      const cached = (await deps.store.getPrices([ref])).get(refKey(ref));
      if (cached) return cached;
      const fetched = (await deps.provider.fetchPrices([ref])).get(refKey(ref));
      if (fetched) await deps.store.putPrices([fetched], PRICE_TTL_MS);
      return fetched;
    },

    async enrich(assets) {
      const refs = await Promise.all(
        assets.map(async (a) => (a ? (await resolve(a, { lazy: false })).ref : null)),
      );
      const present = refs.filter((r) => r !== null);
      const [infos, prices] = await Promise.all([
        deps.store.getInfo(present),
        deps.store.getPrices(present),
      ]);
      return refs.map((ref) =>
        ref ? { ref, info: infos.get(refKey(ref)), price: prices.get(refKey(ref)) } : { ref: null },
      );
    },

    async warm(assets) {
      try {
        await refreshWarm(deps, { now: Date.now() });
        for (const a of assets ?? []) if (a) await resolve(a, { lazy: true });
      } catch {
        // best-effort:预热失败不影响主流程,下次再试。
      }
    },
  };
}

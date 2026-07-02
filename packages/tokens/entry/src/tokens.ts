import type {
  AssetRef,
  Resolution,
  TokenProvider,
  TokenRef,
  TokenStore,
} from "@folio/tokens-basic";
import { OVERRIDES } from "@folio/tokens-basic";
import { createCoinGeckoProvider } from "@folio/tokens-provider-coingecko";
import { type RefreshOpts, type ResolveOpts, refreshWarm, resolveAsset } from "./service";

export interface CreateTokensConfig {
  apiKey?: string;
  // store 实现由调用方注入(D1 在 @folio/db,不该被 tokens 依赖);tokens 把 provider.source 喂进来。
  createStore: (source: TokenRef["source"]) => TokenStore;
  // 默认 provider = CoinGecko;测试可注入 stub。app 不传 → 用默认,不感知具体上游。
  provider?: TokenProvider;
}

// 统一的 tokens 实例(像 @folio/db 的 store 实例):闭包持 provider+store+overrides,方法自带绑定。
// 调用方只拿实例调 .resolveAsset/.refreshWarm/.provider/.store —— 这是 tokens 包唯一的对外组装入口。
export interface Tokens {
  readonly provider: TokenProvider;
  readonly store: TokenStore;
  resolveAsset(asset: AssetRef, opts?: ResolveOpts): Promise<Resolution>;
  refreshWarm(opts: RefreshOpts): Promise<{ warm: boolean }>;
}

export function createTokens({ apiKey, createStore, provider }: CreateTokensConfig): Tokens {
  const p = provider ?? createCoinGeckoProvider({ apiKey });
  const deps = { provider: p, store: createStore(p.source), overrides: OVERRIDES };
  return {
    provider: p,
    store: deps.store,
    resolveAsset: (asset, opts) => resolveAsset(asset, deps, opts),
    refreshWarm: (opts) => refreshWarm(deps, opts),
  };
}

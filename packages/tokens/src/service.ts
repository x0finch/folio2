import {
  ABSENT_TTL_MS,
  CONTRACT_TTL_MS,
  DEFAULT_TOP_N,
  PRICE_TTL_MS,
  WARM_TTL_MS,
} from "./constants";
import { chooseResolution, normalizeSymbol } from "./resolve";
import type { TokenSource } from "./source";
import type { TokenStore } from "./store";
import type { AssetRef, Resolution, TokenRef } from "./types";

export interface ResolveDeps {
  source: TokenSource;
  store: TokenStore;
  overrides?: Readonly<Record<string, TokenRef>>;
}

// 懒解析编排(接口驱动,无具体依赖):瀑布的输入由此收集,裁决交纯 `chooseResolution`。
// 合约首见 → `fetchByContract` 取一次并缓存(含 info/price 副作用,P7.4 富化直接读);未收录/404 → 否定缓存。
export async function resolveAsset(asset: AssetRef, deps: ResolveDeps): Promise<Resolution> {
  if (asset.ref) return { ref: asset.ref, confidence: "high", via: "explicit" };

  let contractHit: TokenRef | null = null;
  if (asset.chain && asset.contract) {
    const cached = await deps.store.getContractRef(asset.chain, asset.contract);
    if (cached === undefined) {
      const res = await deps.source.fetchByContract(asset.chain, asset.contract);
      if (res) {
        await deps.store.putContractRef(asset.chain, asset.contract, res.ref, CONTRACT_TTL_MS);
        await deps.store.putInfo([res.info], CONTRACT_TTL_MS);
        await deps.store.putPrices([res.price], PRICE_TTL_MS);
        contractHit = res.ref;
      } else {
        await deps.store.putContractRef(asset.chain, asset.contract, null, ABSENT_TTL_MS);
      }
    } else {
      contractHit = cached; // TokenRef 命中,或 null(已知缺失)
    }
  }

  const symbol = normalizeSymbol(asset.symbol);
  const candidates = await deps.store.getCandidates(symbol);
  const override = deps.overrides?.[symbol];
  return chooseResolution(asset, { contractHit, candidates, override });
}

export interface RefreshDeps {
  source: TokenSource;
  store: TokenStore;
}

export interface RefreshOpts {
  now: number;
  topN?: number;
  warmTtlMs?: number;
}

// TTL 门控的预热刷新(供 P7.4 的 cron/sync 入口后台触发)。过期才拉 top-N markets,否则跳过。
// (chain 的源内映射由各 source 自管,不在此刷。)
export async function refreshWarm(
  deps: RefreshDeps,
  opts: RefreshOpts,
): Promise<{ warm: boolean }> {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const warmTtl = opts.warmTtlMs ?? WARM_TTL_MS;

  const warmAsOf = await deps.store.warmAsOf();
  if (warmAsOf === null || opts.now - warmAsOf > warmTtl) {
    await deps.store.putWarm(await deps.source.fetchMarkets({ topN }), warmTtl);
    return { warm: true };
  }
  return { warm: false };
}

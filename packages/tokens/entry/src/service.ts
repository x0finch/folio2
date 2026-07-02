import type {
  AssetRef,
  Resolution,
  TokenProvider,
  TokenRef,
  TokenStore,
} from "@folio/tokens-basic";
import {
  ABSENT_TTL_MS,
  CONTRACT_TTL_MS,
  DEFAULT_TOP_N,
  PRICE_TTL_MS,
  WARM_TTL_MS,
} from "@folio/tokens-basic";
import { normalizeChain, normalizeContract, normalizeSymbol } from "./normalize";
import { chooseResolution } from "./resolve";

export interface ResolveDeps {
  provider: TokenProvider;
  store: TokenStore;
  overrides?: Readonly<Record<string, TokenRef>>;
}

export interface ResolveOpts {
  // true(默认,预热路径):合约缓存 miss 时 fetchByContract 取一次并缓存。
  // false(展示路径):cache-only,合约 miss 不取网络、留空,只读 warm/override → 页面零网络延迟。
  lazy?: boolean;
}

// 懒解析编排(接口驱动,无具体依赖):瀑布的输入由此收集,裁决交纯 `chooseResolution`。
// 合约首见(lazy)→ `fetchByContract` 取一次并缓存(含 info/price 副作用,展示直接读);未收录/404 → 否定缓存。
export async function resolveAsset(
  asset: AssetRef,
  deps: ResolveDeps,
  opts?: ResolveOpts,
): Promise<Resolution> {
  if (asset.ref) return { ref: asset.ref, confidence: "high", via: "explicit" };
  const lazy = opts?.lazy ?? true;

  let contractHit: TokenRef | null = null;
  if (asset.chain && asset.contract) {
    // store 缓存键(chain, contract)归一(小写)在此完成 —— store 只按 key 存/查,不做归一;
    // provider 收原始寻址(各 provider 内部自行翻译/归一)。
    const chain = normalizeChain(asset.chain);
    const contract = normalizeContract(asset.contract);
    const cached = await deps.store.getContractRef(chain, contract);
    if (cached !== undefined) {
      contractHit = cached; // TokenRef 命中,或 null(已知缺失)
    } else if (lazy) {
      const res = await deps.provider.fetchByContract(asset.chain, asset.contract);
      if (res) {
        await deps.store.putContractRef(chain, contract, res.ref, CONTRACT_TTL_MS);
        await deps.store.putInfo([res.info], CONTRACT_TTL_MS);
        await deps.store.putPrices([res.price], PRICE_TTL_MS);
        contractHit = res.ref;
      } else {
        await deps.store.putContractRef(chain, contract, null, ABSENT_TTL_MS);
      }
    }
    // lazy=false 且 miss:不取网络,contractHit 留空 → 降级到 warm/override/none
  }

  const symbol = normalizeSymbol(asset.symbol);
  const candidates = await deps.store.getCandidates(symbol);
  const override = deps.overrides?.[symbol];
  return chooseResolution(asset, { contractHit, candidates, override });
}

export interface RefreshDeps {
  provider: TokenProvider;
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
    const markets = await deps.provider.fetchMarkets({ topN });
    // 归一 symbol(warm 分桶 key 的口径)在写 store 之前完成 —— store 只按 key 存,不做业务归一。
    const rows = markets.map((m) => ({
      price: m.price,
      info: { ...m.info, symbol: normalizeSymbol(m.info.symbol) },
    }));
    await deps.store.putWarm(rows, warmTtl);
    return { warm: true };
  }
  return { warm: false };
}

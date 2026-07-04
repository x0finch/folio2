import type {
  AssetRef,
  CgkCoinId,
  Resolution,
  TokenProvider,
  TokenRef,
  TokenStore,
} from "@folio/tokens-basic";
import {
  CGK_RECHECK_TTL_MS,
  CONTRACT_TTL_MS,
  DEFAULT_TOP_N,
  INFO_TTL_MS,
  PRICE_TTL_MS,
  parseTokenIdentifier,
  WARM_TTL_MS,
} from "@folio/tokens-basic";
import { normalizeSymbol } from "./normalize";
import { chooseResolution } from "./resolve";

export interface ResolveDeps {
  provider: TokenProvider;
  store: TokenStore;
  overrides?: Readonly<Record<string, TokenRef>>;
}

export interface ResolveOpts {
  // true(默认,预热路径):实现键 miss/待复查时 fetchByContract 取一次并落库(升级合并)。
  // false(展示路径):cache-only,不取网络 → 页面零网络延迟。
  lazy?: boolean;
}

// 懒解析编排:实现键(caip19)→ 代币表;命中 cgk 行直接升格;孤儿/miss 且 lazy → 问 CGK,
// 命中则升级合并(linkImplToCgk),未收录则 seed 孤儿 + 记复查时刻(期间 provider 数据照常展示)。
export async function resolveAsset(
  asset: AssetRef,
  deps: ResolveDeps,
  opts?: ResolveOpts,
): Promise<Resolution> {
  if (asset.ref) return { ref: asset.ref, confidence: "high", via: "explicit" };
  const lazy = opts?.lazy ?? true;

  let contractHit: TokenRef | null = null;
  // 实现键(持仓侧已构造的 tokenIdentifier)= impl 索引键 + 懒解析原料。
  const key = asset.tokenIdentifier;
  const parsed = key ? parseTokenIdentifier(key) : undefined;
  // coingecko:<id> 形的 tokenIdentifier 本身就是规范 ref(厂商寻址,如 manual 用户选币)→ 直接命中,
  // 不查索引、不掉回 symbol。等同显式 ref。
  if (parsed?.cgkId) {
    return {
      ref: { source: "coingecko", identifier: parsed.cgkId as CgkCoinId },
      confidence: "high",
      via: "explicit",
    };
  }
  if (key) {
    const rec = (await deps.store.getByImpl([key])).get(key);
    if (rec?.ref) {
      contractHit = rec.ref;
    } else if (
      lazy &&
      parsed?.contract &&
      parsed.chainRef &&
      (rec?.cgkCheckedUntil ?? 0) <= Date.now()
    ) {
      // 反查用 chainRef(eip155 的数字 chainId 更可靠地命中 CGK 平台;chain: 形式给 slug)。
      const res = await deps.provider.fetchByContract(parsed.chainRef, parsed.contract);
      if (res) {
        await deps.store.linkImplToCgk(key, res.info, res.price, {
          indexTtlMs: CONTRACT_TTL_MS,
          infoTtlMs: INFO_TTL_MS,
          priceTtlMs: PRICE_TTL_MS,
        });
        contractHit = res.ref;
      } else {
        // CGK 未收录:确保孤儿在(展示仍有 symbol 可用)+ 记复查时刻
        if (!rec) {
          await deps.store.ensureImplToken(
            key,
            { symbol: normalizeSymbol(asset.symbol) },
            CONTRACT_TTL_MS,
          );
        }
        await deps.store.markCgkChecked(key, Date.now() + CGK_RECHECK_TTL_MS);
      }
    }
    // lazy=false 且无 cgk 命中,或 native/无合约:不取网络,降级到 override/symbol
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
export async function refreshWarm(
  deps: RefreshDeps,
  opts: RefreshOpts,
): Promise<{ warm: boolean }> {
  const topN = opts.topN ?? DEFAULT_TOP_N;
  const warmTtl = opts.warmTtlMs ?? WARM_TTL_MS;

  const warmAsOf = await deps.store.warmAsOf();
  if (warmAsOf === null || opts.now - warmAsOf > warmTtl) {
    const markets = await deps.provider.fetchMarkets({ topN });
    // 归一 symbol(索引 key 的口径)在写 store 之前完成 —— store 只按 key 存,不做业务归一。
    const rows = markets.map((m) => ({
      price: m.price,
      info: { ...m.info, symbol: normalizeSymbol(m.info.symbol) },
    }));
    await deps.store.putWarm(rows, warmTtl, INFO_TTL_MS);
    return { warm: true };
  }
  return { warm: false };
}

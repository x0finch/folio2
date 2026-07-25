import type {
  AssetRef,
  CgkCoinId,
  Resolution,
  TokenRef,
  TokenSource,
  TokenStore,
} from "@folio/oracle-basic";
import {
  CGK_RECHECK_TTL_MS,
  DEFAULT_TOP_N,
  INFO_TTL_MS,
  PRICE_TTL_MS,
  TOKEN_KEY_TTL_MS,
  WARM_TTL_MS,
} from "@folio/oracle-basic";
import { parseTokenRef } from "@folio/oracle-ref";
import { normalizeSymbol } from "./normalize";
import { chooseResolution } from "./resolve";

export interface ResolveDeps {
  source: TokenSource;
  store: TokenStore;
  overrides?: Readonly<Record<string, TokenRef>>;
}

export interface ResolveOpts {
  // true(默认,预热路径):tokenKey miss/待复查时 fetchByContract 取一次并落库(升级合并)。
  // false(展示路径):cache-only,不取网络 → 页面零网络延迟。
  lazy?: boolean;
}

// 懒解析编排:tokenKey → 代币表;命中 cgk 行直接升格;孤儿/miss 且 lazy → 问 CGK,
// 命中则升级合并(linkTokenKeyToCgk),未收录则 seed 孤儿 + 记复查时刻(期间 source 数据照常展示)。
// 厂商命名者:`coingecko/<id>` 形的 tokenRef 即规范 ref。
const CGK_NAMER = "coingecko";

// 命名者 → 喂 `fetchByContract` 的链引用:EVM 给数字 chainId(比 slug 更可靠地命中 CGK 平台),
// 其余给 slug 本身。
const EVM_NAMER_PREFIX = "eip155:";
const chainRefOf = (namer: string): string =>
  namer.startsWith(EVM_NAMER_PREFIX) ? namer.slice(EVM_NAMER_PREFIX.length) : namer;

export async function resolveAsset(
  asset: AssetRef,
  deps: ResolveDeps,
  opts?: ResolveOpts,
): Promise<Resolution> {
  if (asset.ref) return { ref: asset.ref, confidence: "high", via: "explicit" };
  const lazy = opts?.lazy ?? true;

  let contractHit: TokenRef | null = null;
  // tokenKey(持仓侧已构造)= 索引键 + 懒解析原料。
  const key = asset.tokenKey;
  const parsed = key ? parseTokenRef(key) : undefined;
  // `coingecko/<id>` 形的 tokenRef 本身就是规范 ref(厂商寻址,如 manual 用户选币)→ 直接命中,
  // 不查索引、不掉回 symbol。等同显式 ref。其余场馆命名(binance/USDC 等)不是规范 ref,照走索引/symbol。
  if (parsed?.kind === "opaque" && parsed.namer === CGK_NAMER) {
    return {
      ref: { source: "coingecko", identifier: parsed.id as CgkCoinId },
      confidence: "high",
      via: "explicit",
    };
  }
  if (key) {
    const rec = (await deps.store.getByTokenKey([key])).get(key);
    if (rec?.ref) {
      contractHit = rec.ref;
    } else if (lazy && parsed?.kind === "contract" && (rec?.cgkCheckedUntil ?? 0) <= Date.now()) {
      // 反查用命名者(eip155:<id> 的数字 chainId 更可靠地命中 CGK 平台;非 EVM 链给 slug)。
      const res = await deps.source.fetchByContract(chainRefOf(parsed.namer), parsed.address);
      if (res) {
        await deps.store.linkTokenKeyToCgk(key, res.info, res.price, {
          indexTtlMs: TOKEN_KEY_TTL_MS,
          infoTtlMs: INFO_TTL_MS,
          priceTtlMs: PRICE_TTL_MS,
        });
        contractHit = res.ref;
      } else {
        // CGK 未收录:确保孤儿在(展示仍有 symbol 可用)+ 记复查时刻
        if (!rec) {
          await deps.store.ensureTokenKey(
            key,
            { symbol: normalizeSymbol(asset.symbol) },
            TOKEN_KEY_TTL_MS,
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
  source: TokenSource;
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
    const markets = await deps.source.fetchMarkets({ topN });
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

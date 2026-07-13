import type {
  CgkCoinId,
  DefiLlamaCoinId,
  PriceSource,
  TokenInfo,
  TokenPrice,
  TokenRecord,
  TokenRecordPrice,
  TokenRef,
  TokenSource,
  TokenStore,
} from "@folio/oracle-basic";
import { refKey } from "@folio/oracle-basic";
import { describe, expect, it, vi } from "vitest";
import { createTokens } from "../src/services/tokens";

// #93 双源:meta 恒 baseline(CoinGecko)供身份/目录/搜索/解析;取价与读价走活跃价源(DefiLlama)。
// 合约币经活跃源合约寻址(fetchByContract→link 落该源那格价),读时 overlay 到 baseline 记录上。

const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as CgkCoinId });
const dl = (id: string): TokenRef => ({ source: "defillama", identifier: id as DefiLlamaCoinId });

const KEY = "eip155:1/erc20:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48"; // USDC @ Ethereum(合约币)
const INTERNAL_ID = "internal-usdc";

// 双源 fake stores:meta(身份+baseline 价)共享;每源各自一格价(按 source 分桶,per-vendor)。
function makeStores() {
  // baseline 记录:tokenKey → 记录(带 id + coingecko 那格价,标记 stale 以触发刷新)。
  const metaRec: TokenRecord & { cgkCheckedUntil: number | null } = {
    id: INTERNAL_ID,
    ref: cg("usd-coin"),
    symbol: "USDC",
    name: "USD Coin",
    price: { unitPrice: 1, asOf: 0, stale: true },
    cgkCheckedUntil: null,
  };
  const pricesBySource = new Map<string, Map<string, TokenRecordPrice>>();

  const create = (source: TokenRef["source"]): TokenStore => {
    const prices = pricesBySource.get(source) ?? new Map<string, TokenRecordPrice>();
    pricesBySource.set(source, prices);
    return {
      getCandidates: async () => [],
      putWarm: async () => {},
      warmAsOf: async () => 9_999_999_999_999, // 新鲜 → warm 跳过
      listTopTokens: async () => [],
      getByTokenKey: async (keys) => {
        const out = new Map<string, TokenRecord & { cgkCheckedUntil: number | null }>();
        if (source === "coingecko" && keys.includes(KEY)) out.set(KEY, metaRec);
        return out;
      },
      ensureTokenKey: async () => {},
      markCgkChecked: async () => {},
      linkTokenKeyToCgk: async (_key, _info, price) => {
        // link 落【本源】那格价到共享内部 id(#83 重锚:defillama 映射→同一 id)。
        if (price)
          prices.set(INTERNAL_ID, { unitPrice: price.unitPrice, asOf: price.asOf, stale: false });
      },
      getByRefs: async (refs) => {
        const out = new Map<string, TokenRecord>();
        if (source === "coingecko" && refs.some((r) => refKey(r) === "coingecko:usd-coin"))
          out.set("coingecko:usd-coin", metaRec);
        return out;
      },
      getById: async (id) => (source === "coingecko" && id === INTERNAL_ID ? metaRec : undefined),
      putPrices: async () => {},
      getPricesByIds: async (ids) => {
        const out = new Map<string, TokenRecordPrice>();
        for (const id of ids) {
          const p = prices.get(id);
          if (p) out.set(id, p);
        }
        return out;
      },
    };
  };
  return { create, pricesBySource };
}

// meta 源(CoinGecko):spy searchTokens / fetchPrices 以证明目录/长尾刷价走它。
function metaStub() {
  return {
    source: "coingecko" as const,
    fetchMarkets: vi.fn(async () => []),
    searchTokens: vi.fn(
      async (): Promise<TokenInfo[]> => [{ ref: cg("x"), symbol: "X", name: "X" }],
    ),
    fetchByContract: vi.fn(async () => null),
    fetchPrices: vi.fn(async () => new Map<string, TokenPrice>()),
  } satisfies TokenSource;
}

// 活跃价源(DefiLlama):合约寻址返回链上价 0.999;fetchPrices 为长尾。
function priceStub(): PriceSource & {
  fetchByContract: ReturnType<typeof vi.fn>;
  fetchPrices: ReturnType<typeof vi.fn>;
} {
  const ref = dl("ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48");
  return {
    source: "defillama",
    fetchByContract: vi.fn(async () => ({
      ref,
      info: { ref, symbol: "USDC", name: "USDC" } as TokenInfo,
      price: { ref, unitPrice: 0.999, asOf: 123 } as TokenPrice,
    })),
    fetchPrices: vi.fn(async () => new Map<string, TokenPrice>()),
  };
}

describe("createTokens 双源分派(#93)", () => {
  it("合约币 refreshStalePrices → 走活跃源 fetchByContract(非 meta.fetchPrices),link 落活跃源那格", async () => {
    const { create } = makeStores();
    const meta = metaStub();
    const price = priceStub();
    const tokens = createTokens({ createStore: create, source: meta, priceSource: price });

    const n = await tokens.refreshStalePrices([{ symbol: "USDC", tokenKey: KEY }]);

    expect(price.fetchByContract).toHaveBeenCalledTimes(1); // 活跃源合约寻址
    expect(meta.fetchPrices).not.toHaveBeenCalled(); // 合约币不落 baseline 长尾
    expect(n).toBe(1);
  });

  it("enrich overlay:活跃源那格价(0.999)覆盖 baseline(1.0)", async () => {
    const { create } = makeStores();
    const meta = metaStub();
    const price = priceStub();
    const tokens = createTokens({ createStore: create, source: meta, priceSource: price });

    // 先刷价(把 0.999 落进 defillama 那格),再富化读取。
    await tokens.refreshStalePrices([{ symbol: "USDC", tokenKey: KEY }]);
    const [enriched] = await tokens.enrich([{ symbol: "USDC", tokenKey: KEY }]);

    expect(enriched.unitPrice).toBe(0.999); // 活跃源价,非 baseline 1.0
  });

  it("enrich:活跃源无该币价 → 保留 baseline 价(native/未建映射兜底)", async () => {
    const { create } = makeStores();
    const tokens = createTokens({
      createStore: create,
      source: metaStub(),
      priceSource: priceStub(),
    });
    // 不刷价 → defillama 那格空 → overlay 落空 → 用 baseline 1.0。
    const [enriched] = await tokens.enrich([{ symbol: "USDC", tokenKey: KEY }]);
    expect(enriched.unitPrice).toBe(1);
  });

  it("search 恒走 meta 源(目录权威在 baseline)", async () => {
    const { create } = makeStores();
    const meta = metaStub();
    const tokens = createTokens({ createStore: create, source: meta, priceSource: priceStub() });
    await tokens.search("usdc");
    expect(meta.searchTokens).toHaveBeenCalledWith("usdc");
  });

  it("单源(无 priceSource)行为不变:refreshStalePrices 走 meta.fetchPrices", async () => {
    const { create } = makeStores();
    const meta = metaStub();
    meta.fetchPrices.mockResolvedValueOnce(
      new Map([["coingecko:usd-coin", { ref: cg("usd-coin"), unitPrice: 1, asOf: 0 }]]),
    );
    const tokens = createTokens({ createStore: create, source: meta }); // 无 priceSource
    await tokens.refreshStalePrices([{ symbol: "USDC", tokenKey: KEY }]);
    expect(meta.fetchPrices).toHaveBeenCalledTimes(1);
  });
});

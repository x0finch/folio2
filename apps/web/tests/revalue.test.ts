import type { Balance } from "@folio/core";
import type {
  CoinId,
  ResolveDeps,
  TokenCandidate,
  TokenInfo,
  TokenPrice,
  TokenRef,
  TokenStore,
} from "@folio/tokens";
import { OVERRIDES } from "@folio/tokens";
import { describe, expect, it } from "vitest";
import { revalueManual } from "../src/lib/revalue";

const cg = (id: string): TokenRef => ({ source: "coingecko", coinId: id as CoinId });
const key = (r: TokenRef) => `${r.source}:${r.coinId}`;

// 假 store:warm 已就绪(warmAsOf 新鲜 → refreshWarm 跳过取数);BTC→bitcoin 候选 + 价。
function fakeStore(): TokenStore {
  const candidates = new Map<string, TokenCandidate[]>([
    ["BTC", [{ ref: cg("bitcoin"), marketCapRank: 1 }]],
  ]);
  const prices = new Map<string, TokenPrice>([
    [key(cg("bitcoin")), { ref: cg("bitcoin"), unitPrice: 65000, asOf: 0 }],
  ]);
  return {
    getCandidates: async (s) => candidates.get(s) ?? [],
    putWarm: async () => {},
    warmAsOf: async () => 9_999_999_999_999, // 远未来 → refreshWarm 视为新鲜、跳过取数
    listTopTokens: async () => [],
    getContractRef: async () => undefined,
    putContractRef: async () => {},
    getInfo: async () => new Map<string, TokenInfo>(),
    putInfo: async () => {},
    getPrices: async (refs) => {
      const out = new Map<string, TokenPrice>();
      for (const r of refs) {
        const p = prices.get(key(r));
        if (p) out.set(key(r), p);
      }
      return out;
    },
    putPrices: async () => {},
  };
}

// source:fetchPrices 为长尾 coinId 供价(模拟不在 warm 的币);其余 stub。
const stubSource = {
  fetchMarkets: async () => [],
  fetchByContract: async () => null,
  fetchPrices: async (refs: TokenRef[]) => {
    const out = new Map<string, TokenPrice>();
    for (const r of refs) {
      if (r.coinId === ("the-open-network" as CoinId)) {
        out.set(key(r), { ref: r, unitPrice: 5, asOf: 0 });
      }
    }
    return out;
  },
  searchCoins: async () => [],
};

const deps = (): ResolveDeps => ({ source: stubSource, store: fakeStore(), overrides: OVERRIDES });
const bal = (symbol: string, amount: number, usdValue: number, coinId?: string): Balance => ({
  symbol,
  amount,
  usdValue,
  source: "manual",
  kind: "manual",
  ...(coinId ? { meta: { coinId } } : {}),
});

describe("revalueManual", () => {
  it("manual resolvable → usdValue = amount × market price", async () => {
    const out = await revalueManual(deps(), "manual", [bal("BTC", 0.5, 1)]);
    expect(out[0].usdValue).toBe(32500); // 0.5 × 65000
  });

  it("manual unresolvable → keeps provider usdValue (unitPrice fallback)", async () => {
    const out = await revalueManual(deps(), "manual", [bal("PRIVATETOKEN", 10, 99)]);
    expect(out[0].usdValue).toBe(99);
  });

  it("meta.fixed → keeps provider usdValue even when symbol resolves", async () => {
    // BTC 可解析(store 有价 65000),但锁定固定值 → 保留 provider 的 usdValue=1。
    const locked: Balance = {
      symbol: "BTC",
      amount: 0.5,
      usdValue: 1,
      source: "manual",
      kind: "manual",
      meta: { fixed: true },
    };
    const out = await revalueManual(deps(), "manual", [locked]);
    expect(out[0].usdValue).toBe(1);
  });

  it("explicit meta.coinId overrides symbol resolution", async () => {
    // 错的 symbol "XBT" 但显式 coinId=bitcoin → 用 bitcoin 的 store 价 65000。
    const out = await revalueManual(deps(), "manual", [bal("XBT", 1, 0, "bitcoin")]);
    expect(out[0].usdValue).toBe(65000);
  });

  it("explicit coinId not in warm cache → source.fetchPrices supplies the price", async () => {
    const out = await revalueManual(deps(), "manual", [bal("TONCOIN", 2, 0, "the-open-network")]);
    expect(out[0].usdValue).toBe(10); // 2 × 5(来自 source.fetchPrices)
  });

  it("non-manual → untouched (enrich-not-reprice)", async () => {
    const spot: Balance = {
      symbol: "BTC",
      amount: 1,
      usdValue: 60000,
      source: "binance",
      kind: "spot",
    };
    const out = await revalueManual(deps(), "exchange_binance", [spot]);
    expect(out[0].usdValue).toBe(60000);
  });
});

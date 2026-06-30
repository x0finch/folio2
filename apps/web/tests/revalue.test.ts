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

// source 不会被调用(warm 新鲜 + 无合约 + 价在 store);全 stub。
const stubSource = {
  fetchMarkets: async () => [],
  fetchByContract: async () => null,
  fetchPrices: async () => new Map(),
};

const deps = (): ResolveDeps => ({ source: stubSource, store: fakeStore(), overrides: OVERRIDES });
const bal = (symbol: string, amount: number, usdValue: number): Balance => ({
  symbol,
  amount,
  usdValue,
  source: "manual",
  kind: "manual",
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

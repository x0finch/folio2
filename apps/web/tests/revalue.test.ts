import type { Balance } from "@folio/balances";
import type {
  CgkCoinId,
  TokenCandidate,
  TokenPrice,
  TokenRecord,
  TokenRef,
  TokenStore,
  Tokens,
} from "@folio/tokens";
import { createTokens } from "@folio/tokens";
import { describe, expect, it } from "vitest";
import { revalueManual } from "../src/lib/revalue";

const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as CgkCoinId });
const key = (r: TokenRef) => `${r.source}:${r.identifier}`;

// 假 store:warm 已就绪(warmAsOf 新鲜 → refreshWarm 跳过取数);BTC→bitcoin 候选 + 代币行(新鲜价)。
function fakeStore(): TokenStore {
  const candidates = new Map<string, TokenCandidate[]>([
    ["BTC", [{ ref: cg("bitcoin"), marketCapRank: 1 }]],
  ]);
  const records = new Map<string, TokenRecord>([
    [
      key(cg("bitcoin")),
      {
        id: "bitcoin",
        ref: cg("bitcoin"),
        symbol: "BTC",
        name: "Bitcoin",
        price: { unitPrice: 65000, asOf: 0, stale: false },
      },
    ],
  ]);
  return {
    getCandidates: async (s) => candidates.get(s) ?? [],
    putWarm: async () => {},
    warmAsOf: async () => 9_999_999_999_999, // 远未来 → refreshWarm 视为新鲜、跳过取数
    listTopTokens: async () => [],
    getByImpl: async () => new Map(),
    ensureImplToken: async () => {},
    markCgkChecked: async () => {},
    linkImplToCgk: async () => {},
    getByRefs: async (refs) => {
      const out = new Map<string, TokenRecord>();
      for (const r of refs) {
        const rec = records.get(key(r));
        if (rec) out.set(key(r), rec);
      }
      return out;
    },
    putPrices: async () => {},
  };
}

// source:fetchPrices 为长尾 identifier 供价(模拟不在 warm 的币);其余 stub。
const stubSource = {
  source: "coingecko" as const,
  fetchMarkets: async () => [],
  fetchByContract: async () => null,
  fetchPrices: async (refs: TokenRef[]) => {
    const out = new Map<string, TokenPrice>();
    for (const r of refs) {
      if (r.identifier === ("the-open-network" as CgkCoinId)) {
        out.set(key(r), { ref: r, unitPrice: 5, asOf: 0 });
      }
    }
    return out;
  },
  searchTokens: async () => [],
};

// tokens 实例:真 createTokens,注入 stub provider + fake store(避免真网络)。
const tokens = (): Tokens => createTokens({ createStore: () => fakeStore(), provider: stubSource });
const bal = (symbol: string, amount: number, value: number, identifier?: string): Balance => ({
  symbol,
  amount,
  value,
  kind: "manual",
  // 用户选币 → tokenIdentifier 的厂商寻址形(coingecko:<id>),身份不再进 meta。
  ...(identifier ? { tokenIdentifier: `coingecko:${identifier}` } : {}),
});

describe("revalueManual", () => {
  it("manual resolvable → value = amount × market price", async () => {
    const out = await revalueManual(tokens(), "manual", [bal("BTC", 0.5, 1)]);
    expect(out[0].value).toBe(32500); // 0.5 × 65000
  });

  it("manual unresolvable → keeps provider value (unitPrice fallback)", async () => {
    const out = await revalueManual(tokens(), "manual", [bal("PRIVATETOKEN", 10, 99)]);
    expect(out[0].value).toBe(99);
  });

  it("meta.fixed → keeps provider value even when symbol resolves", async () => {
    // BTC 可解析(store 有价 65000),但锁定固定值 → 保留 provider 的 value=1。
    const locked: Balance = {
      symbol: "BTC",
      amount: 0.5,
      value: 1,
      kind: "manual",
      meta: { fixed: true },
    };
    const out = await revalueManual(tokens(), "manual", [locked]);
    expect(out[0].value).toBe(1);
  });

  it("explicit coingecko tokenIdentifier overrides symbol resolution", async () => {
    // 错的 symbol "XBT" 但 tokenIdentifier=coingecko:bitcoin → 用 bitcoin 的 store 价 65000。
    const out = await revalueManual(tokens(), "manual", [bal("XBT", 1, 0, "bitcoin")]);
    expect(out[0].value).toBe(65000);
  });

  it("explicit tokenIdentifier not in warm cache → source.fetchPrices supplies the price", async () => {
    const out = await revalueManual(tokens(), "manual", [bal("TONCOIN", 2, 0, "the-open-network")]);
    expect(out[0].value).toBe(10); // 2 × 5(来自 source.fetchPrices)
  });

  it("non-manual → untouched (enrich-not-reprice)", async () => {
    const spot: Balance = {
      symbol: "BTC",
      amount: 1,
      value: 60000,
      kind: "spot",
    };
    const out = await revalueManual(tokens(), "exchange_binance", [spot]);
    expect(out[0].value).toBe(60000);
  });
});

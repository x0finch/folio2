import type { Balance } from "@folio/connectors-basic";
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
import { revalue } from "../src/lib/revalue";

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
    getByTokenKey: async () => new Map(),
    ensureTokenKey: async () => {},
    markCgkChecked: async () => {},
    linkTokenKeyToCgk: async () => {},
    getByRefs: async (refs) => {
      const out = new Map<string, TokenRecord>();
      for (const r of refs) {
        const rec = records.get(key(r));
        if (rec) out.set(key(r), rec);
      }
      return out;
    },
    getById: async (id) => [...records.values()].find((r) => r.id === id),
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

// tokens 实例:真 createTokens,注入 stub source + fake store(避免真网络)。
const tokens = (): Tokens => createTokens({ createStore: () => fakeStore(), source: stubSource });
const bal = (symbol: string, amount: number, value: number, identifier?: string): Balance => ({
  symbol,
  amount,
  value,
  kind: "spot", // manual connector 产 spot kind(旧 "manual" kind 已并入 5-kind 的 spot)
  // 用户选币 → tokenKey 的厂商寻址形(coingecko:<id>),身份不再进 meta。
  ...(identifier ? { tokenKey: `coingecko:${identifier}` } : {}),
});

describe("revalue", () => {
  it("manual resolvable → value = amount × market price", async () => {
    const out = await revalue(tokens(), true, [bal("BTC", 0.5, 1)]);
    expect(out[0].value).toBe(32500); // 0.5 × 65000
  });

  it("manual unresolvable → keeps provider value (unitPrice fallback)", async () => {
    const out = await revalue(tokens(), true, [bal("PRIVATETOKEN", 10, 99)]);
    expect(out[0].value).toBe(99);
  });

  it("explicit coingecko tokenKey overrides symbol resolution", async () => {
    // 错的 symbol "XBT" 但 tokenKey=coingecko:bitcoin → 用 bitcoin 的 store 价 65000。
    const out = await revalue(tokens(), true, [bal("XBT", 1, 0, "bitcoin")]);
    expect(out[0].value).toBe(65000);
  });

  it("explicit tokenKey not in warm cache → source.fetchPrices supplies the price", async () => {
    const out = await revalue(tokens(), true, [bal("TONCOIN", 2, 0, "the-open-network")]);
    expect(out[0].value).toBe(10); // 2 × 5(来自 source.fetchPrices)
  });

  it("non-revalue type (exchange) → untouched (enrich-not-reprice)", async () => {
    const spot: Balance = {
      symbol: "BTC",
      amount: 1,
      value: 60000,
      kind: "spot",
    };
    const out = await revalue(tokens(), false, [spot]);
    expect(out[0].value).toBe(60000);
  });

  it("bitcoin → 盯市:provider 只给 amount(value=0),按 BTC 市价算 value", async () => {
    // bitcoin provider 产 value=0、kind=spot(ADR 0010:BTC 并回 spot)、tokenKey=chain:bitcoin/native:btc,
    // 靠 symbol 回退到 bitcoin 价 65000。未确认/派生明细走 account 级 note,不在 balance meta。
    const btc: Balance = {
      symbol: "BTC",
      amount: 0.08,
      value: 0,
      kind: "spot",
      tokenKey: "chain:bitcoin/native:btc",
    };
    const out = await revalue(tokens(), true, [btc]);
    expect(out[0].value).toBe(5200); // 0.08 × 65000
  });

  it("非盯市类型 self-first:捕获 selfPrice(= value/amount)、value 不变、不回源", async () => {
    const spot: Balance = { symbol: "BTC", amount: 2, value: 120000, kind: "spot" };
    const out = await revalue(tokens(), false, [spot]); // 默认 self-first
    expect(out[0].value).toBe(120000); // 自带价权威,不动
    expect(out[0].selfPrice).toBe(60000); // 120000 / 2,捕获为原料
  });

  it("source-first:非盯市类型也改用源价,selfPrice 仍作原料留存", async () => {
    const spot: Balance = { symbol: "BTC", amount: 2, value: 120000, kind: "spot" };
    const out = await revalue(tokens(), false, [spot], "source-first");
    expect(out[0].value).toBe(130000); // 2 × 65000(源价)
    expect(out[0].price).toBe(65000);
    expect(out[0].selfPrice).toBe(60000); // 自带价不丢 → 可切回
  });

  it("source-first 源无价 → 回退自带价", async () => {
    const spot: Balance = { symbol: "PRIVATETOKEN", amount: 10, value: 99, kind: "spot" };
    const out = await revalue(tokens(), false, [spot], "source-first");
    expect(out[0].value).toBe(99); // 源无该币 → 自带兜底
    expect(out[0].selfPrice).toBe(9.9);
  });
});

// —— 永续行不按市价重估(P5.1:仓位 value 恒 0、权益 = 账户净值;否则净值被名义敞口污染) ——
describe("revalue —— 永续行保留 provider value", () => {
  const perp = (kind: "perp_position" | "perp_equity", amount: number, value: number): Balance =>
    ({ symbol: "ETH", amount, value, kind }) as unknown as Balance;

  it("perp_position value 恒 0(即便数量大、币可解析),不重估成 数量×币价", async () => {
    const out = await revalue(tokens(), true, [perp("perp_position", -40391.56, 0)]);
    expect(out[0].value).toBe(0);
  });
  it("perp_equity 保留账户净值,不按 数量×币价 覆写", async () => {
    const out = await revalue(tokens(), true, [perp("perp_equity", 34427709, 34425196)]);
    expect(out[0].value).toBe(34425196);
  });
});

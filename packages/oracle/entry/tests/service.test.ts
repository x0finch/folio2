import type {
  CgkCoinId,
  TokenCandidate,
  TokenInfo,
  TokenPrice,
  TokenRecord,
  TokenRef,
  TokenSource,
  TokenStore,
} from "@folio/oracle-basic";
import { OVERRIDES } from "@folio/oracle-basic";
import { describe, expect, it, vi } from "vitest";
import { normalizeSymbol } from "../src/services/tokens/normalize";
import { refreshWarm, resolveAsset } from "../src/services/tokens/service";

const cg = (id: string): TokenRef => ({ source: "coingecko", identifier: id as CgkCoinId });
const key = (r: TokenRef) => `${r.source}:${r.identifier}`;

// 内存假 store(实现新 TokenStore:代币表按 refKey、实现索引按 tokenKey 键、warm 候选、warmAsOf)。
function fakeStore(seed?: { warmAsOf?: number }): TokenStore {
  let wAsOf = seed?.warmAsOf ?? null;
  const candidates = new Map<string, TokenCandidate[]>();
  const byRef = new Map<string, TokenRecord>();
  const impl = new Map<string, { rec: TokenRecord; cgkCheckedUntil: number | null }>();

  return {
    async getCandidates(symbol) {
      return candidates.get(symbol) ?? [];
    },
    async putWarm(rows) {
      for (const { info, price } of rows) {
        const sym = normalizeSymbol(info.symbol);
        const list = candidates.get(sym) ?? [];
        list.push({ ref: info.ref, marketCapRank: price.marketCapRank });
        candidates.set(sym, list);
        byRef.set(key(info.ref), {
          id: key(info.ref),
          ref: info.ref,
          symbol: info.symbol,
          name: info.name,
          logo: info.logo,
          price: { unitPrice: price.unitPrice, asOf: price.asOf, stale: false },
        });
      }
      wAsOf = 0;
    },
    async warmAsOf() {
      return wAsOf;
    },
    async listTopTokens() {
      return [];
    },
    async getByTokenKey(keys) {
      const out = new Map<string, TokenRecord & { cgkCheckedUntil: number | null }>();
      for (const k of keys) {
        const e = impl.get(k);
        if (e) out.set(k, { ...e.rec, cgkCheckedUntil: e.cgkCheckedUntil });
      }
      return out;
    },
    async ensureTokenKey(k, seed2) {
      const e = impl.get(k);
      if (e) {
        if (seed2.providerLogo) e.rec.providerLogo = seed2.providerLogo;
        return;
      }
      impl.set(k, {
        rec: {
          id: k,
          ref: null,
          symbol: seed2.symbol,
          name: seed2.name ?? seed2.symbol,
          providerLogo: seed2.providerLogo,
        },
        cgkCheckedUntil: null,
      });
    },
    async markCgkChecked(k, until) {
      const e = impl.get(k);
      if (e) e.cgkCheckedUntil = until;
    },
    async linkTokenKeyToCgk(k, info, price) {
      const orphan = impl.get(k)?.rec;
      const rec: TokenRecord = {
        id: key(info.ref),
        ref: info.ref,
        symbol: info.symbol,
        name: info.name,
        logo: info.logo,
        providerLogo: byRef.get(key(info.ref))?.providerLogo ?? orphan?.providerLogo,
        price: price
          ? { unitPrice: price.unitPrice, asOf: price.asOf, stale: false }
          : byRef.get(key(info.ref))?.price,
      };
      byRef.set(key(info.ref), rec);
      impl.set(k, { rec, cgkCheckedUntil: null });
    },
    async getByRefs(refs) {
      const out = new Map<string, TokenRecord>();
      for (const r of refs) {
        const v = byRef.get(key(r));
        if (v) out.set(key(r), v);
      }
      return out;
    },
    async getById(id) {
      for (const v of byRef.values()) if (v.id === id) return v;
      for (const e of impl.values()) if (e.rec.id === id) return e.rec;
      return undefined;
    },
    async putPrices(list) {
      for (const p of list) {
        const rec = byRef.get(key(p.ref));
        if (rec) rec.price = { unitPrice: p.unitPrice, asOf: p.asOf, stale: false };
      }
    },
    async getPricesByIds(ids) {
      const out = new Map<string, NonNullable<TokenRecord["price"]>>();
      const recs = [...byRef.values(), ...[...impl.values()].map((e) => e.rec)];
      for (const rec of recs)
        if (rec.id && ids.includes(rec.id) && rec.price) out.set(rec.id, rec.price);
      return out;
    },
  };
}

const info = (ref: TokenRef, symbol: string): TokenInfo => ({ ref, symbol, name: symbol });
const price = (ref: TokenRef, rank?: number): TokenPrice => ({
  ref,
  unitPrice: 1,
  marketCapRank: rank,
  asOf: 0,
});

describe("resolveAsset", () => {
  it("explicit ref short-circuits (no store/source touch)", async () => {
    expect(
      await resolveAsset(
        { symbol: "X", ref: cg("pinned") },
        { source: {} as TokenSource, store: fakeStore() },
      ),
    ).toEqual({ ref: cg("pinned"), confidence: "high", via: "explicit" });
  });

  it("coingecko: tokenKey (厂商寻址,如 manual 选币) → 直达显式 ref,不查 store/source", async () => {
    const fetchByContract = vi.fn();
    const source = { fetchByContract } as unknown as TokenSource;
    expect(
      await resolveAsset(
        { symbol: "BTC", tokenKey: "coingecko:bitcoin" },
        { source, store: fakeStore() },
      ),
    ).toEqual({ ref: cg("bitcoin"), confidence: "high", via: "explicit" });
    expect(fetchByContract).not.toHaveBeenCalled(); // 已是规范 ref,不回源、不掉 symbol
  });

  it("contract: unknown → fetchByContract, links impl→cgk; 2nd call no refetch", async () => {
    const store = fakeStore();
    const fetchByContract = vi.fn(async () => ({
      ref: cg("usd-coin"),
      info: info(cg("usd-coin"), "usdc"),
      price: price(cg("usd-coin"), 6),
    }));
    const source = { fetchByContract } as unknown as TokenSource;
    const asset = { symbol: "USDC", tokenKey: "chain:ethereum/token:0xabc" };

    const r1 = await resolveAsset(asset, { source, store });
    expect(r1).toEqual({ ref: cg("usd-coin"), confidence: "high", via: "contract" });
    const rec = (await store.getByRefs([cg("usd-coin")])).get("coingecko:usd-coin");
    expect(rec?.symbol).toBe("usdc");
    expect(rec?.price?.unitPrice).toBe(1);

    const r2 = await resolveAsset(asset, { source, store });
    expect(r2.via).toBe("contract");
    expect(fetchByContract).toHaveBeenCalledTimes(1); // tokenKey 索引已指向 cgk,不再回源
    expect(fetchByContract).toHaveBeenCalledWith("ethereum", "0xabc"); // chainRef + contract parsed from tokenKey
  });

  it("lazy:false (display) → impl miss does NOT hit source", async () => {
    const store = fakeStore();
    const fetchByContract = vi.fn(async () => ({
      ref: cg("usd-coin"),
      info: info(cg("usd-coin"), "usdc"),
      price: price(cg("usd-coin"), 6),
    }));
    const source = { fetchByContract } as unknown as TokenSource;
    const asset = { symbol: "USDC", tokenKey: "chain:ethereum/token:0xabc" };

    const r = await resolveAsset(asset, { source, store }, { lazy: false });
    expect(r.via).toBe("none"); // 无 warm/override 时降级
    expect(fetchByContract).not.toHaveBeenCalled(); // cache-only,零网络
  });

  it("contract: source returns null (CGK 未收录) → none, orphan seeded + recheck marked, no refetch", async () => {
    const store = fakeStore();
    const fetchByContract = vi.fn(async () => null);
    const source = { fetchByContract } as unknown as TokenSource;
    const asset = { symbol: "ZZZ", tokenKey: "chain:ethereum/token:0xdead" };

    expect(await resolveAsset(asset, { source, store })).toEqual({
      ref: null,
      confidence: "low",
      via: "none",
    });
    // 孤儿已 seed(展示仍有 symbol)且记了复查时刻
    const rec = (await store.getByTokenKey(["chain:ethereum/token:0xdead"])).get(
      "chain:ethereum/token:0xdead",
    );
    expect(rec).toMatchObject({ ref: null, symbol: "ZZZ" });
    expect(rec?.cgkCheckedUntil).toBeGreaterThan(Date.now());

    await resolveAsset(asset, { source, store });
    expect(fetchByContract).toHaveBeenCalledTimes(1); // 复查时刻未到,不再回源
  });

  it("no chain/contract → skips contract path, uses warm symbol", async () => {
    const store = fakeStore();
    await store.putWarm(
      [{ info: info(cg("ethereum"), "eth"), price: price(cg("ethereum"), 2) }],
      0,
      0,
    );
    expect(await resolveAsset({ symbol: "ETH" }, { source: {} as TokenSource, store })).toEqual({
      ref: cg("ethereum"),
      confidence: "high",
      via: "symbol",
    });
  });

  it("override (not in warm) → via override", async () => {
    expect(
      await resolveAsset(
        { symbol: "BTC" },
        { source: {} as TokenSource, store: fakeStore(), overrides: OVERRIDES },
      ),
    ).toEqual({ ref: cg("bitcoin"), confidence: "high", via: "override" });
  });

  it("nothing resolves → none", async () => {
    expect(
      await resolveAsset({ symbol: "NOPE" }, { source: {} as TokenSource, store: fakeStore() }),
    ).toEqual({ ref: null, confidence: "low", via: "none" });
  });
});

describe("refreshWarm", () => {
  it("stale (never refreshed) → fetches markets, warms candidates", async () => {
    const store = fakeStore();
    const fetchMarkets = vi.fn(async () => [
      { info: info(cg("bitcoin"), "btc"), price: price(cg("bitcoin"), 1) },
    ]);
    const source = { fetchMarkets } as unknown as TokenSource;

    expect(await refreshWarm({ source, store }, { now: 1_000_000 })).toEqual({ warm: true });
    expect(fetchMarkets).toHaveBeenCalledTimes(1);
    expect(await store.getCandidates("BTC")).toEqual([{ ref: cg("bitcoin"), marketCapRank: 1 }]);
  });

  it("fresh → skips", async () => {
    const now = 1_000_000;
    const store = fakeStore({ warmAsOf: now });
    const fetchMarkets = vi.fn();
    const source = { fetchMarkets } as unknown as TokenSource;

    expect(await refreshWarm({ source, store }, { now: now + 1000 })).toEqual({ warm: false });
    expect(fetchMarkets).not.toHaveBeenCalled();
  });
});

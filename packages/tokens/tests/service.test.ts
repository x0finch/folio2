import { describe, expect, it, vi } from "vitest";
import { OVERRIDES } from "../src/constants";
import { normalizeSymbol } from "../src/resolve";
import { refreshWarm, resolveAsset } from "../src/service";
import type { TokenSource } from "../src/source";
import type { TokenStore } from "../src/store";
import type { CoinId, TokenCandidate, TokenInfo, TokenPrice, TokenRef } from "../src/types";

const cg = (id: string): TokenRef => ({ source: "coingecko", coinId: id as CoinId });
const key = (r: TokenRef) => `${r.source}:${r.coinId}`;
const ck = (chain: string, contract: string) => `${chain.toLowerCase()} ${contract.toLowerCase()}`;

// 内存假 store(实现新 TokenStore;合约缓存按 chain 三态、warm 候选、warmAsOf)。
function fakeStore(seed?: { warmAsOf?: number }): TokenStore {
  let wAsOf = seed?.warmAsOf ?? null;
  const candidates = new Map<string, TokenCandidate[]>();
  const contracts = new Map<string, TokenRef | null>();
  const infos = new Map<string, TokenInfo>();
  const prices = new Map<string, TokenPrice>();

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
        infos.set(key(info.ref), info);
        prices.set(key(price.ref), price);
      }
      wAsOf = 0;
    },
    async warmAsOf() {
      return wAsOf;
    },
    async getContractRef(chain, contract) {
      const k = ck(chain, contract);
      return contracts.has(k) ? contracts.get(k) : undefined;
    },
    async putContractRef(chain, contract, ref) {
      contracts.set(ck(chain, contract), ref);
    },
    async getInfo(refs) {
      const out = new Map<string, TokenInfo>();
      for (const r of refs) {
        const v = infos.get(key(r));
        if (v) out.set(key(r), v);
      }
      return out;
    },
    async putInfo(list) {
      for (const i of list) infos.set(key(i.ref), i);
    },
    async getPrices(refs) {
      const out = new Map<string, TokenPrice>();
      for (const r of refs) {
        const v = prices.get(key(r));
        if (v) out.set(key(r), v);
      }
      return out;
    },
    async putPrices(list) {
      for (const p of list) prices.set(key(p.ref), p);
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

  it("contract: unknown → fetchByContract, caches ref+info+price; 2nd call no refetch", async () => {
    const store = fakeStore();
    const fetchByContract = vi.fn(async () => ({
      ref: cg("usd-coin"),
      info: info(cg("usd-coin"), "usdc"),
      price: price(cg("usd-coin"), 6),
    }));
    const source = { fetchByContract } as unknown as TokenSource;
    const asset = { symbol: "USDC", chain: "ethereum", contract: "0xABC" };

    const r1 = await resolveAsset(asset, { source, store });
    expect(r1).toEqual({ ref: cg("usd-coin"), confidence: "high", via: "contract" });
    expect((await store.getInfo([cg("usd-coin")])).get("coingecko:usd-coin")?.symbol).toBe("usdc");
    expect((await store.getPrices([cg("usd-coin")])).size).toBe(1);

    const r2 = await resolveAsset(asset, { source, store });
    expect(r2.via).toBe("contract");
    expect(fetchByContract).toHaveBeenCalledTimes(1); // cached
    expect(fetchByContract).toHaveBeenCalledWith("ethereum", "0xABC"); // source gets our chain
  });

  it("lazy:false (display) → contract cache miss does NOT hit source", async () => {
    const store = fakeStore();
    const fetchByContract = vi.fn(async () => ({
      ref: cg("usd-coin"),
      info: info(cg("usd-coin"), "usdc"),
      price: price(cg("usd-coin"), 6),
    }));
    const source = { fetchByContract } as unknown as TokenSource;
    const asset = { symbol: "USDC", chain: "ethereum", contract: "0xABC" };

    const r = await resolveAsset(asset, { source, store }, { lazy: false });
    expect(r.via).toBe("none"); // 无 warm/override 时降级
    expect(fetchByContract).not.toHaveBeenCalled(); // cache-only,零网络
  });

  it("contract: source returns null (unmapped chain / 404) → none, absent cached, no refetch", async () => {
    const store = fakeStore();
    const fetchByContract = vi.fn(async () => null);
    const source = { fetchByContract } as unknown as TokenSource;
    const asset = { symbol: "ZZZ", chain: "ethereum", contract: "0xDEAD" };

    expect(await resolveAsset(asset, { source, store })).toEqual({
      ref: null,
      confidence: "low",
      via: "none",
    });
    await resolveAsset(asset, { source, store });
    expect(fetchByContract).toHaveBeenCalledTimes(1); // absent cached
  });

  it("no chain/contract → skips contract path, uses warm symbol", async () => {
    const store = fakeStore();
    await store.putWarm(
      [{ info: info(cg("ethereum"), "eth"), price: price(cg("ethereum"), 2) }],
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

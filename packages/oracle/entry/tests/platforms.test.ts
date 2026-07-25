import type { PlatformMeta, PlatformRow, PlatformSource, PlatformStore } from "@folio/oracle-basic";
import { createCoinGeckoPlatformSource } from "@folio/oracle-source-coingecko";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createPlatforms } from "../src/services/platforms";

const ASSET_PLATFORMS = [
  {
    id: "arbitrum-one",
    chain_identifier: 42161,
    name: "Arbitrum One",
    image: { small: "https://cgk/arbitrum.jpg" },
  },
  { id: "solana", chain_identifier: null, name: "Solana", image: { small: "https://cgk/sol.jpg" } },
  { id: "no-image", chain_identifier: 999 }, // 无 name/image → 降级
];

function mockFetch(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    headers: new Headers(),
  } as Response);
}

// 按 URL 路径分派的 fetch mock(venue 单查用)。
function mockFetchByPath(routes: Record<string, { status?: number; body?: unknown }>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input); // 客户端传 URL 对象 → href
    const hit = Object.entries(routes).find(([p]) => url.includes(p));
    const r = hit?.[1] ?? { status: 404 };
    const status = r.status ?? 200;
    return {
      ok: status < 400,
      status,
      json: async () => r.body ?? {},
      headers: new Headers(),
    } as Response;
  });
}

afterEach(() => vi.restoreAllMocks());

describe("coingecko fetchChains", () => {
  it("每条链产短形 slug;有数字 chainId 再产 eip155:<id>;取 image.small", async () => {
    mockFetch(ASSET_PLATFORMS);
    const rows = await createCoinGeckoPlatformSource().fetchChains();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("arbitrum-one")).toMatchObject({
      name: "Arbitrum One",
      logo: "https://cgk/arbitrum.jpg",
    });
    expect(byKey.get("eip155:42161")).toMatchObject({
      name: "Arbitrum One",
      logo: "https://cgk/arbitrum.jpg",
    });
    expect(byKey.get("solana")).toMatchObject({ name: "Solana" });
    expect(byKey.has("eip155:999")).toBe(true); // no-image 仍产 key
    expect(byKey.get("no-image")?.name).toBe("no-image"); // 无 name → 降级为 id
    expect(byKey.get("no-image")?.logo).toBeUndefined();
  });
});

describe("coingecko fetchVenue", () => {
  it("exchange:* → /exchanges/{id};perp:* → /derivatives/exchanges/{id};image 是直链", async () => {
    mockFetchByPath({
      "/exchanges/binance": { body: { name: "Binance", image: "https://cgk/binance.png" } },
      "/derivatives/exchanges/hyperliquid": {
        body: { name: "Hyperliquid (Futures)", image: "https://cgk/hl.png" },
      },
    });
    const src = createCoinGeckoPlatformSource();
    expect(await src.fetchVenue("exchange:binance")).toEqual({
      key: "exchange:binance",
      name: "Binance",
      logo: "https://cgk/binance.png",
    });
    expect(await src.fetchVenue("perp:hyperliquid")).toEqual({
      key: "perp:hyperliquid",
      name: "Hyperliquid (Futures)",
      logo: "https://cgk/hl.png",
    });
  });

  it("404 → null;非 venue 前缀 → null(不发请求)", async () => {
    const spy = mockFetchByPath({}); // 全 404
    const src = createCoinGeckoPlatformSource();
    expect(await src.fetchVenue("exchange:nope")).toBeNull();
    expect(await src.fetchVenue("solana")).toBeNull();
    expect(spy).toHaveBeenCalledTimes(1); // 链键未发请求
  });
});

// —— service:假 source + 假 store ——
function fakeStore(seed: PlatformRow[] = []): PlatformStore & { rows: Map<string, PlatformRow> } {
  const rows = new Map(seed.map((r) => [r.key, r]));
  return {
    rows,
    async getPlatforms(keys) {
      const out = new Map<string, PlatformRow>();
      for (const k of keys) {
        const r = rows.get(k);
        if (r) out.set(k, r);
      }
      return out;
    },
    async putPlatforms(next) {
      for (const r of next) rows.set(r.key, r);
    },
  };
}

describe("createPlatforms.resolve", () => {
  it("每个 key 都给展示:命中用真名;否定缓存/未命中用兜底名(slug-cap;eip155 用原 key)", async () => {
    const store = fakeStore([
      { key: "eip155:1", name: "Ethereum", logo: "e.jpg", expiresAt: 9e15 },
      { key: "exchange:x", name: null, logo: null, expiresAt: 9e15 }, // 否定缓存
    ]);
    const p = createPlatforms({ source: {} as PlatformSource, store });
    const m = await p.resolve(["eip155:1", "exchange:x", "chain:none", "manual"]);
    expect(m.get("eip155:1")).toEqual({ key: "eip155:1", name: "Ethereum", logo: "e.jpg" });
    expect(m.get("exchange:x")).toEqual({ key: "exchange:x", name: "X" }); // 否定缓存 → 兜底
    expect(m.get("chain:none")).toEqual({ key: "chain:none", name: "None" }); // 未命中 → 兜底
    expect(m.get("manual")).toEqual({ key: "manual", name: "Manual" });
  });
});

describe("createPlatforms.warm", () => {
  it("链缓存缺失/过期 → fetchChains + 写入;全新鲜 → 跳过取数", async () => {
    let chainFetches = 0;
    const source: PlatformSource = {
      async fetchChains(): Promise<PlatformMeta[]> {
        chainFetches++;
        return [{ key: "eip155:1", name: "Ethereum", logo: "e.jpg" }];
      },
      async fetchVenue(): Promise<PlatformMeta | null> {
        return null;
      },
    };
    const store = fakeStore();
    const p = createPlatforms({ source, store, now: () => 1000 });

    await p.warm(["eip155:1"]); // 缺失 → 取
    expect(chainFetches).toBe(1);
    expect(store.rows.get("eip155:1")?.name).toBe("Ethereum");

    await p.warm(["eip155:1"]); // 已新鲜 → 不再取
    expect(chainFetches).toBe(1);
  });

  it("venue 单查:命中长 TTL;404 → name=null 短 TTL 否定缓存;新鲜则不再查", async () => {
    const calls: string[] = [];
    const source: PlatformSource = {
      async fetchChains() {
        return [];
      },
      async fetchVenue(key) {
        calls.push(key);
        return key === "exchange:binance" ? { key, name: "Binance", logo: "b.png" } : null; // exchange:okx → 未收录
      },
    };
    const store = fakeStore();
    const p = createPlatforms({ source, store, now: () => 1000 });

    await p.warm(["exchange:binance", "exchange:okx"]);
    expect(calls).toEqual(["exchange:binance", "exchange:okx"]);
    expect(store.rows.get("exchange:binance")).toMatchObject({ name: "Binance", logo: "b.png" });
    const neg = store.rows.get("exchange:okx");
    expect(neg?.name).toBeNull(); // 否定缓存
    expect(neg?.expiresAt).toBeLessThan(store.rows.get("exchange:binance")!.expiresAt); // 短 TTL

    // 二次:两者都新鲜 → 不再单查。
    await p.warm(["exchange:binance", "exchange:okx"]);
    expect(calls).toEqual(["exchange:binance", "exchange:okx"]);
  });
});

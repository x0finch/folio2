import { afterEach, describe, expect, it, vi } from "vitest";
import { createCoinGeckoPlatformSource } from "../src/coingecko";
import { createPlatforms } from "../src/service";
import type { PlatformMeta, PlatformRow, PlatformSource, PlatformStore } from "../src/types";

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
afterEach(() => vi.restoreAllMocks());

describe("coingecko fetchChains", () => {
  it("每条链产 chain:<slug>;有数字 chainId 再产 eip155:<id>;取 image.small", async () => {
    mockFetch(ASSET_PLATFORMS);
    const rows = await createCoinGeckoPlatformSource().fetchChains();
    const byKey = new Map(rows.map((r) => [r.key, r]));
    expect(byKey.get("chain:arbitrum-one")).toMatchObject({
      name: "Arbitrum One",
      logo: "https://cgk/arbitrum.jpg",
    });
    expect(byKey.get("eip155:42161")).toMatchObject({
      name: "Arbitrum One",
      logo: "https://cgk/arbitrum.jpg",
    });
    expect(byKey.get("chain:solana")).toMatchObject({ name: "Solana" });
    expect(byKey.has("eip155:999")).toBe(true); // no-image 仍产 key
    expect(byKey.get("chain:no-image")?.name).toBe("no-image"); // 无 name → 降级为 id
    expect(byKey.get("chain:no-image")?.logo).toBeUndefined();
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
  it("命中返回 PlatformMeta;name=null(否定缓存)不返回;未命中跳过", async () => {
    const store = fakeStore([
      { key: "eip155:1", name: "Ethereum", logo: "e.jpg", expiresAt: 9e15 },
      { key: "exchange:x", name: null, logo: null, expiresAt: 9e15 }, // 否定缓存
    ]);
    const p = createPlatforms({ source: {} as PlatformSource, store });
    const m = await p.resolve(["eip155:1", "exchange:x", "chain:none"]);
    expect(m.get("eip155:1")).toEqual({ key: "eip155:1", name: "Ethereum", logo: "e.jpg" });
    expect(m.has("exchange:x")).toBe(false);
    expect(m.has("chain:none")).toBe(false);
  });
});

describe("createPlatforms.warm", () => {
  it("链缓存缺失/过期 → fetchChains + 写入;全新鲜 → 跳过取数", async () => {
    let fetches = 0;
    const source: PlatformSource = {
      async fetchChains(): Promise<PlatformMeta[]> {
        fetches++;
        return [{ key: "eip155:1", name: "Ethereum", logo: "e.jpg" }];
      },
    };
    const store = fakeStore();
    const p = createPlatforms({ source, store, now: () => 1000 });

    await p.warm(["eip155:1"]); // 缺失 → 取
    expect(fetches).toBe(1);
    expect(store.rows.get("eip155:1")?.name).toBe("Ethereum");

    await p.warm(["eip155:1"]); // 已新鲜 → 不再取
    expect(fetches).toBe(1);

    await p.warm(["exchange:binance"]); // 非链 key → 本期不取
    expect(fetches).toBe(1);
  });
});

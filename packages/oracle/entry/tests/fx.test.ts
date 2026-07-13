import type { FxRow, FxSource, FxStore } from "@folio/oracle-basic";
import { createCoinGeckoFxSource } from "@folio/oracle-source-coingecko";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFxRates } from "../src/services/fx";

function mockFetch(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    headers: new Headers(),
  } as Response);
}
afterEach(() => vi.restoreAllMocks());

// exchange_rates:value = 每 1 BTC 值多少该币种。usdPerUnit(code) = usd.value / code.value。
const RATES = {
  rates: {
    btc: { value: 1, type: "crypto" },
    usd: { value: 100000, type: "fiat" }, // 1 BTC = 100000 USD
    eur: { value: 92000, type: "fiat" }, // 1 BTC = 92000 EUR → 1 EUR = 100000/92000 ≈ 1.087 USD
    eth: { value: 40, type: "crypto" }, // 1 BTC = 40 ETH → 1 ETH = 2500 USD
  },
};

describe("createCoinGeckoFxSource.fetchRates", () => {
  it("反算 usdPerUnit:USD=1、EUR=usd/eur、ETH=usd/eth", async () => {
    mockFetch(RATES);
    const rates = await createCoinGeckoFxSource().fetchRates();
    expect(rates.get("USD")).toBe(1);
    expect(rates.get("EUR")).toBeCloseTo(100000 / 92000, 6); // ≈ 1.08696
    expect(rates.get("ETH")).toBe(2500); // 100000 / 40
    expect(rates.get("BTC")).toBe(100000); // usd/btc = 100000/1
  });

  it("缺 usd 汇率 → FxError PARSE_ERROR", async () => {
    mockFetch({ rates: { eur: { value: 1 } } });
    await expect(createCoinGeckoFxSource().fetchRates()).rejects.toMatchObject({
      code: "PARSE_ERROR",
    });
  });
});

// —— service:假 source + 假 store ——
function fakeStore(seed: FxRow[] = []): FxStore & { rows: Map<string, FxRow> } {
  const rows = new Map(seed.map((r) => [r.currency, r]));
  return {
    rows,
    async getRates(currencies) {
      const out = new Map<string, FxRow>();
      for (const c of currencies) {
        const r = rows.get(c);
        if (r) out.set(c, r);
      }
      return out;
    },
    async putRates(next) {
      for (const r of next) rows.set(r.currency, r);
    },
  };
}

describe("createFxRates.resolve", () => {
  it("USD 恒 1(不查缓存);命中返 usdPerUnit;软过期仍返回;缺 → undefined", async () => {
    const store = fakeStore([
      { currency: "EUR", usdPerUnit: 1.087, expiresAt: 9e15 },
      { currency: "JPY", usdPerUnit: 0.0067, expiresAt: 1 }, // 已过期
    ]);
    const fx = createFxRates({ source: {} as FxSource, store, now: () => 1e12 });
    expect(await fx.resolve("USD")).toBe(1);
    expect(await fx.resolve("EUR")).toBe(1.087);
    expect(await fx.resolve("JPY")).toBe(0.0067); // 软过期:仍返最近值
    expect(await fx.resolve("GBP")).toBeUndefined(); // 缺
  });
});

describe("createFxRates.warm", () => {
  it("缺失/过期 → fetchRates + 写入;全新鲜 → 跳过;USD 不计入陈旧判断", async () => {
    let fetches = 0;
    const source: FxSource = {
      async fetchRates() {
        fetches++;
        return new Map([
          ["USD", 1],
          ["EUR", 1.09],
        ]);
      },
    };
    const store = fakeStore();
    const fx = createFxRates({ source, store, now: () => 1000 });

    await fx.warm(["USD", "EUR"]); // EUR 缺 → 取
    expect(fetches).toBe(1);
    expect(store.rows.get("EUR")?.usdPerUnit).toBe(1.09);
    expect(store.rows.get("EUR")?.expiresAt).toBeGreaterThan(1000);

    await fx.warm(["USD", "EUR"]); // 都新鲜 → 不取
    expect(fetches).toBe(1);

    await fx.warm(["USD"]); // 仅 USD → 无目标,不取
    expect(fetches).toBe(1);
  });
});

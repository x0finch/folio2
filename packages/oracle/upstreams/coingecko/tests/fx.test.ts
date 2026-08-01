import { bypassRateLimitsForTests, resetRateLimitsForTests } from "@folio/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createCoinGeckoFxUpstream } from "../src";

// 限速闸:每个用例从干净状态出发,且 sleep 即时 —— 否则无 key 档(10 次/分钟)会让这套测试
// **真的等**,而上一个用例撞出来的冷却还会漏给下一个。生产不传 sleep(用 setTimeout)。
const NO_WAIT = { sleep: async () => {} };
// 限速闸旁路:这个文件测的不是限频。闸的行为在 @folio/shared 的单测里用假时钟验过,
// 这里让它直接放行 —— 否则每个用例都要按窗口真等。
bypassRateLimitsForTests(true);

beforeEach(() => resetRateLimitsForTests());

function mockFetch(body: unknown) {
  return vi.spyOn(globalThis, "fetch").mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => body,
    headers: new Headers(),
  } as Response);
}
afterEach(() => vi.restoreAllMocks());

// 上游那个端点以 **BTC** 为基准:value = 1 BTC 值多少该币种。
// 我们要的是 usdPerUnit(X) = usd.value / X.value(BTC 约掉)。
const RATES = {
  rates: {
    btc: { value: 1, type: "crypto" },
    usd: { value: 100000, type: "fiat" }, // 1 BTC = 100000 USD
    eur: { value: 92000, type: "fiat" }, // 1 EUR = 100000/92000 ≈ 1.087 USD
    eth: { value: 40, type: "crypto" }, // 1 ETH = 2500 USD
  },
};

describe("createCoinGeckoFxUpstream.fetchRates", () => {
  it("反算 usdPerUnit:USD=1、EUR=usd/eur、ETH=usd/eth、BTC=usd/btc", async () => {
    mockFetch(RATES);
    const rates = await createCoinGeckoFxUpstream(NO_WAIT).fetchRates();

    expect(rates.get("USD")).toBe(1);
    expect(rates.get("EUR")).toBeCloseTo(100000 / 92000, 6);
    expect(rates.get("ETH")).toBe(2500);
    expect(rates.get("BTC")).toBe(100000);
  });

  it("上游没收录的币种不出现(不是报错)", async () => {
    mockFetch(RATES);
    const rates = await createCoinGeckoFxUpstream(NO_WAIT).fetchRates();
    expect(rates.has("KRW")).toBe(false); // 这份响应里没有 krw
  });

  it("只出白名单里的币种 —— 上游多给的不进结果", async () => {
    mockFetch({ rates: { ...RATES.rates, xag: { value: 3000, type: "commodity" } } });
    const rates = await createCoinGeckoFxUpstream(NO_WAIT).fetchRates();
    expect(rates.has("XAG")).toBe(false);
  });

  it("基准(usd)缺失 → 抛:这不是「某个币种没有」,是响应坏了", async () => {
    mockFetch({ rates: { eur: { value: 1 } } });
    await expect(createCoinGeckoFxUpstream(NO_WAIT).fetchRates()).rejects.toThrow(/usd rate/);
  });

  it("id 自报为当前上游 —— 与代币那面同一个命名者", async () => {
    expect(createCoinGeckoFxUpstream(NO_WAIT).id).toBe("coingecko");
  });
});

// 汇率的 BTC 反算基(ADR 0026):历史反算取「BTC 在某币种下的价」走的是 PriceUpstream.fetchPriceSeries
//(见 upstream.test.ts 的 vsCurrency 用例),FxUpstream 只声明这个基、不另立取数方法。
describe("createCoinGeckoFxUpstream.btcRef", () => {
  it("btcRef = coingecko/issued:bitcoin —— 与代币那面 BTC 历史价同键(可复用)", () => {
    expect(createCoinGeckoFxUpstream(NO_WAIT).btcRef).toBe("coingecko/issued:bitcoin");
  });
});

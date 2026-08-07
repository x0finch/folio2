import { describe, expect, it } from "vitest";
import { createCoinGeckoFxUpstream, fetchRatesEffect } from "../src/fx";
import { failing, run, stubbing } from "./harness";

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

describe("fetchRates", () => {
  it("反算 usdPerUnit:USD=1、EUR=usd/eur、ETH=usd/eth、BTC=usd/btc", async () => {
    const rates = await run(stubbing(() => RATES), fetchRatesEffect);

    expect(rates.get("USD")).toBe(1);
    expect(rates.get("EUR")).toBeCloseTo(100000 / 92000, 6);
    expect(rates.get("ETH")).toBe(2500);
    expect(rates.get("BTC")).toBe(100000);
  });

  it("上游没收录的币种不出现(不是报错)", async () => {
    const rates = await run(stubbing(() => RATES), fetchRatesEffect);
    expect(rates.has("KRW")).toBe(false); // 这份响应里没有 krw
  });

  it("只出白名单里的币种 —— 上游多给的不进结果", async () => {
    const rates = await run(
      stubbing(() => ({ rates: { ...RATES.rates, xag: { value: 3000, type: "commodity" } } })),
      fetchRatesEffect,
    );
    expect(rates.has("XAG")).toBe(false);
  });

  it("基准(usd)缺失 → 失败:这不是「某个币种没有」,是响应坏了", async () => {
    // 归 parse 那一类,所以**不可重试** —— 再拉一次还是同一份坏形状。
    const err = await failing(
      stubbing(() => ({ rates: { eur: { value: 1 } } })),
      fetchRatesEffect,
    );
    expect(err._tag).toBe("UpstreamParseError");
    expect(err.cause).toBe("missing/invalid usd rate");
  });

  it("id 自报为当前上游 —— 与代币那面同一个命名者", () => {
    expect(createCoinGeckoFxUpstream().id).toBe("coingecko");
  });
});

// 汇率的 BTC 反算基(ADR 0026):历史反算取「BTC 在某币种下的价」走的是 PriceUpstream.fetchPriceSeries
//(见 upstream.test.ts 的 vsCurrency 用例),FxUpstream 只声明这个基、不另立取数方法。
describe("btcRef", () => {
  it("btcRef = coingecko/issued:bitcoin —— 与代币那面 BTC 历史价同键(可复用)", () => {
    expect(createCoinGeckoFxUpstream().btcRef).toBe("coingecko/issued:bitcoin");
  });
});

import { describe, expect, it } from "vitest";
import {
  cgkRef,
  coinIdOf,
  parseMarkets,
  parsePriceSeries,
  parseSearch,
  parseSimplePrice,
  UPSTREAM_ID,
} from "../src";
import simplePrice from "./fixtures/simple-price.json";

// CoinGecko 响应 → 契约形状的纯解析。**只有本包认识这些字段名**(ADR 0023)。
describe("ref 与 coin id 的双向", () => {
  it("造:coin id 规范为小写 kebab,命名者恒为本 adapter 的 id", () => {
    expect(cgkRef("USD-Coin")).toBe(`${UPSTREAM_ID}/issued:usd-coin`);
  });

  it("取:本源命名的 ref → coin id;别家 / 链上寻址 → undefined", () => {
    expect(coinIdOf(`${UPSTREAM_ID}/issued:bitcoin`)).toBe("bitcoin");
    expect(coinIdOf("evm:1/contract:0xa0b8")).toBeUndefined(); // 链上寻址
    expect(coinIdOf("coinmarketcap/issued:1")).toBeUndefined(); // 别家发的标识
    // **左段是本源也不够** —— 右段得是本源「发的标识」那一支,合约地址不是 coin id。
    expect(coinIdOf(`${UPSTREAM_ID}/contract:0xa0b8`)).toBeUndefined();
    expect(coinIdOf(`${UPSTREAM_ID}/custom:MYCOIN`)).toBeUndefined();
  });
});

describe("parseMarkets", () => {
  it("一行 → 元信息 + 价(USD);跳过无 id / 无 symbol 的行", () => {
    const rows = parseMarkets([
      {
        id: "bitcoin",
        symbol: "btc",
        name: "Bitcoin",
        image: "b.png",
        current_price: 60000,
        market_cap_rank: 1,
        price_change_percentage_24h: 1.5,
        last_updated: "2023-11-14T22:13:20.000Z",
      },
      { symbol: "no-id" },
      { id: "no-symbol" },
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      ref: `${UPSTREAM_ID}/issued:bitcoin`,
      symbol: "btc",
      name: "Bitcoin",
      logo: "b.png",
    });
    expect(rows[0]?.price).toMatchObject({ unitPrice: 60000, marketCapRank: 1, change24h: 1.5 });
    expect(rows[0]?.price?.asOf).toBe(Date.parse("2023-11-14T22:13:20.000Z"));
  });
});

describe("parseSearch / parseSimplePrice / parsePriceSeries", () => {
  it("search:name 缺则回退 symbol;取 large 优先", () => {
    const out = parseSearch({ coins: [{ id: "bitcoin", symbol: "btc", large: "l.png" }] });
    expect(out).toEqual([
      { ref: `${UPSTREAM_ID}/issued:bitcoin`, symbol: "btc", name: "btc", logo: "l.png" },
    ]);
  });

  it("search:带上 market_cap_rank(选币下拉的消歧徽标);缺则不带", () => {
    const out = parseSearch({
      coins: [
        { id: "usd-coin", symbol: "usdc", name: "USD Coin", large: "l.png", market_cap_rank: 6 },
        { id: "bridged-usdc", symbol: "usdc", name: "Bridged USDC" }, // 无 rank
      ],
    });
    expect(out[0]?.marketCapRank).toBe(6);
    expect(out[1]?.marketCapRank).toBeUndefined();
  });

  // 回的是**录下来的真实响应**:时刻字段叫 `last_updated_at`,**不带** `usd_` 前缀(只有 24h 涨跌带)。
  // 这里以前手写了 `usd_last_updated_at`,解析也读那个名字 —— 两边错得一致,测试绿着,线上每个价的
  // `asOf` 都落成了兜底的「取数那一刻」,而不是 CoinGecko 自己说的更新时刻。
  it("simple/price:按 ref 索引,带 24h 涨跌,时刻用上游给的 last_updated_at(秒→毫秒)", () => {
    const out = parseSimplePrice(simplePrice.response, 999);
    const btc = simplePrice.response.bitcoin;
    expect(out.get(`${UPSTREAM_ID}/issued:bitcoin`)).toEqual({
      unitPrice: btc.usd,
      change24h: btc.usd_24h_change,
      asOf: btc.last_updated_at * 1000,
    });
    expect(out.size).toBe(2);
  });

  it("simple/price:缺 usd 的条目跳过;没给时刻 → 用兜底", () => {
    const out = parseSimplePrice({ broken: { eur: 1 }, plain: { usd: 2 } }, 999);
    expect(out.has(`${UPSTREAM_ID}/issued:broken`)).toBe(false);
    expect(out.get(`${UPSTREAM_ID}/issued:plain`)?.asOf).toBe(999);
  });

  it("price series:剔非数、按时间升序", () => {
    expect(
      parsePriceSeries([
        [3, 30],
        [1, 10],
        [Number.NaN, 20],
      ]),
    ).toEqual([
      { atMs: 1, unitPrice: 10 },
      { atMs: 3, unitPrice: 30 },
    ]);
  });
});

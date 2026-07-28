import { describe, expect, it } from "vitest";
import {
  cgkRef,
  coinIdOf,
  parseContract,
  parseMarkets,
  parsePriceSeries,
  parseSearch,
  parseSimplePrice,
  UPSTREAM_ID,
} from "../src";

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

describe("parseSearch / parseSimplePrice / parseContract / parsePriceSeries", () => {
  it("search:name 缺则回退 symbol;取 large 优先", () => {
    const out = parseSearch({ coins: [{ id: "bitcoin", symbol: "btc", large: "l.png" }] });
    expect(out).toEqual([
      { ref: `${UPSTREAM_ID}/issued:bitcoin`, symbol: "btc", name: "btc", logo: "l.png" },
    ]);
  });

  it("simple/price:按 ref 索引;缺 usd 的条目跳过;有 last_updated_at 则用它(秒→毫秒)", () => {
    const out = parseSimplePrice(
      {
        bitcoin: { usd: 60000, usd_24h_change: 1.5, usd_last_updated_at: 1_700_000_000 },
        broken: { eur: 1 },
      },
      999,
    );
    expect(out.get(`${UPSTREAM_ID}/issued:bitcoin`)).toEqual({
      unitPrice: 60000,
      change24h: 1.5,
      asOf: 1_700_000_000_000,
    });
    expect(out.has(`${UPSTREAM_ID}/issued:broken`)).toBe(false);
  });

  it("contract:无 id → null;无价 → 只出元信息", () => {
    expect(parseContract(null)).toBeNull();
    expect(parseContract({ symbol: "x" })).toBeNull();
    const out = parseContract({ id: "usd-coin", symbol: "usdc", image: { small: "s.png" } });
    expect(out).toMatchObject({ ref: `${UPSTREAM_ID}/issued:usd-coin`, logo: "s.png" });
    expect(out?.price).toBeUndefined();
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

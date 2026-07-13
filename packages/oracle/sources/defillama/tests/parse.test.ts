import { TokenError } from "@folio/oracle-basic";
import { describe, expect, it } from "vitest";
import { parseCoin, parseCurrentPrices, parseRetryAfter } from "../src/index";
import pricesCurrent from "./fixtures/prices_current.json";

const USDC_KEY = "ethereum:0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48";

// 录制 fixtures 的 golden 测试(镜像 coingecko source 的 parse 测试:price/contract 形状)。
describe("parseCurrentPrices", () => {
  it("按 refKey(defillama:<coinKey>)索引,价 USD、asOf = timestamp×1000", () => {
    const prices = parseCurrentPrices(pricesCurrent);
    const btc = prices.get("defillama:coingecko:bitcoin");
    expect(btc?.unitPrice).toBe(65000);
    expect(btc?.asOf).toBe(1782000000 * 1000);
    expect(btc?.ref).toEqual({ source: "defillama", identifier: "coingecko:bitcoin" });
    const usdc = prices.get(`defillama:${USDC_KEY}`);
    expect(usdc?.unitPrice).toBe(1.001);
    // DefiLlama 无 24h 涨跌字段。
    expect(btc?.change24h).toBeUndefined();
  });

  it("跳过无数值 price 的项", () => {
    const prices = parseCurrentPrices({ coins: { "ethereum:0xbad": { symbol: "X" } } });
    expect(prices.size).toBe(0);
  });

  it("缺 timestamp → asOf = 0", () => {
    const prices = parseCurrentPrices({ coins: { "coingecko:x": { price: 2 } } });
    expect(prices.get("defillama:coingecko:x")?.asOf).toBe(0);
  });

  it("坏形状 → PARSE_ERROR", () => {
    expect(() => parseCurrentPrices({})).toThrow(TokenError);
    expect(() => parseCurrentPrices({ coins: null })).toThrow(TokenError);
    expect(() => parseCurrentPrices("nope")).toThrow(TokenError);
  });
});

describe("parseCoin(单 key,contract 寻址)", () => {
  it("命中 → {ref, info(symbol,name=symbol), price}", () => {
    const out = parseCoin(pricesCurrent, USDC_KEY);
    expect(out?.ref).toEqual({ source: "defillama", identifier: USDC_KEY });
    expect(out?.info.symbol).toBe("USDC");
    expect(out?.info.name).toBe("USDC"); // 无 name → 退化为 symbol
    expect(out?.price.unitPrice).toBe(1.001);
  });

  it("key 不在响应 / 无价 → null", () => {
    expect(parseCoin(pricesCurrent, "ethereum:0xmissing")).toBeNull();
    expect(parseCoin({ coins: { "ethereum:0xz": { symbol: "Z" } } }, "ethereum:0xz")).toBeNull();
  });
});

describe("parseRetryAfter", () => {
  it("纯秒数 → ms", () => {
    expect(parseRetryAfter("30")).toBe(30000);
  });
  it("HTTP-date → ms 差", () => {
    const at = Date.parse("2026-10-21T07:27:55.000Z");
    expect(parseRetryAfter("Wed, 21 Oct 2026 07:28:00 GMT", at)).toBe(5000);
  });
  it("缺失/坏值 → undefined", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
  });
});

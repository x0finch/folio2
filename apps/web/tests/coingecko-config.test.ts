import { describe, expect, it } from "vitest";
import { coinGeckoConfigOf } from "@/lib/server/coingecko-config";

// CoinGecko 的 base 覆盖(FOL-84):不设就是生产那条路(client 按有没有 key 选官方基址)。
describe("coinGeckoConfigOf", () => {
  it("什么都不设 → 两项都缺省(官方免费基址、无 key)", () => {
    expect(coinGeckoConfigOf({})).toEqual({ apiKey: undefined, baseUrl: undefined });
  });

  it("空串当没设 —— .dev.vars 里留一行 `COINGECKO_API_BASE=` 不该把请求打到空基址上", () => {
    expect(coinGeckoConfigOf({ COINGECKO_API_KEY: "", COINGECKO_API_BASE: "  " })).toEqual({
      apiKey: undefined,
      baseUrl: undefined,
    });
  });

  it("设了 base → 原样递给 client(去掉首尾空白)", () => {
    expect(
      coinGeckoConfigOf({
        COINGECKO_API_KEY: "k",
        COINGECKO_API_BASE: " http://127.0.0.1:3399/cg ",
      }),
    ).toEqual({ apiKey: "k", baseUrl: "http://127.0.0.1:3399/cg" });
  });
});

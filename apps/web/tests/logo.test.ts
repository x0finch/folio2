import { describe, expect, it } from "vitest";
import { tokenLogoUrl } from "../src/lib/logo";

describe("tokenLogoUrl", () => {
  it("CGK 源 + 有 logo → 代理 URL(客户端不引用 CoinGecko)", () => {
    expect(
      tokenLogoUrl({
        ref: { source: "coingecko", identifier: "usd-coin" },
        logo: "https://cgk/usdc.png",
      }),
    ).toBe("/api/logo/token/usd-coin");
  });

  it("cgk id 特殊字符被编码", () => {
    expect(
      tokenLogoUrl({
        ref: { source: "coingecko", identifier: "a/b c" },
        logo: "https://cgk/x.png",
      }),
    ).toBe("/api/logo/token/a%2Fb%20c");
  });

  it("孤儿(ref=null)有 providerLogo → 原样(provider CDN,非 CoinGecko)", () => {
    expect(tokenLogoUrl({ ref: null, providerLogo: "https://zerion/x.png" })).toBe(
      "https://zerion/x.png",
    );
  });

  it("CGK 源但无 canonical logo、只有 providerLogo → 原样兜底", () => {
    expect(
      tokenLogoUrl({
        ref: { source: "coingecko", identifier: "foo" },
        providerLogo: "https://p/f.png",
      }),
    ).toBe("https://p/f.png");
  });

  it("完全无 logo → undefined(客户端首字母,不发请求)", () => {
    expect(tokenLogoUrl({ ref: { source: "coingecko", identifier: "foo" } })).toBeUndefined();
    expect(tokenLogoUrl({ ref: null })).toBeUndefined();
  });
});

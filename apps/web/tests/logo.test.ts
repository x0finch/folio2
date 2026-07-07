import { describe, expect, it } from "vitest";
import { platformLogoUrl, tokenLogoUrl } from "../src/lib/logo";

describe("tokenLogoUrl", () => {
  it("有内部 id + canonical logo → 代理 URL(客户端不引用第三方 CDN)", () => {
    expect(tokenLogoUrl({ id: "uuid-1", logo: "https://cgk/usdc.png" })).toBe(
      "/api/logo/token/uuid-1",
    );
  });

  it("有内部 id + 仅 providerLogo(孤儿)→ 也代理(不再泄露给 provider CDN)", () => {
    expect(tokenLogoUrl({ id: "uuid-2", providerLogo: "https://zerion/x.png" })).toBe(
      "/api/logo/token/uuid-2",
    );
  });

  it("内部 id 特殊字符被编码", () => {
    expect(tokenLogoUrl({ id: "a/b c", logo: "https://cgk/x.png" })).toBe(
      "/api/logo/token/a%2Fb%20c",
    );
  });

  it("无内部 id(如 live search 结果)但有 logo → 原样返回上游 URL(降级)", () => {
    expect(tokenLogoUrl({ logo: "https://cgk/x.png" })).toBe("https://cgk/x.png");
    expect(tokenLogoUrl({ providerLogo: "https://p/f.png" })).toBe("https://p/f.png");
  });

  it("有内部 id 但无任何 logo → undefined(不代理空图)", () => {
    expect(tokenLogoUrl({ id: "uuid-3" })).toBeUndefined();
  });

  it("完全无 logo → undefined(客户端首字母,不发请求)", () => {
    expect(tokenLogoUrl({})).toBeUndefined();
  });
});

describe("platformLogoUrl", () => {
  it("有上游图 → 代理 URL(平台 key 即稳定 id)", () => {
    expect(platformLogoUrl("chain:bitcoin", "https://cgk/btc.png")).toBe(
      "/api/logo/platform/chain%3Abitcoin",
    );
  });

  it("key 含特殊字符(:)被编码", () => {
    expect(platformLogoUrl("eip155:1", "https://cgk/eth.png")).toBe(
      "/api/logo/platform/eip155%3A1",
    );
  });

  it("无上游图 → undefined(客户端 fallback,不发请求)", () => {
    expect(platformLogoUrl("chain:bitcoin")).toBeUndefined();
    expect(platformLogoUrl("exchange:binance", undefined)).toBeUndefined();
  });
});

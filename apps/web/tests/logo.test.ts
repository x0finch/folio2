import { describe, expect, it } from "vitest";
import { platformLogoUrl, tokenLogoUrl, toLogoSource } from "@/lib/core/logo";

describe("tokenLogoUrl", () => {
  it("有内部 id + 有图 → 代理 URL(客户端不引用第三方 CDN;URL 由 id 派生,不进 payload)", () => {
    expect(tokenLogoUrl({ id: "uuid-1", hasLogo: true })).toBe("/api/logo/token/uuid-1");
  });

  it("内部 id 特殊字符被编码", () => {
    expect(tokenLogoUrl({ id: "a/b c", hasLogo: true })).toBe("/api/logo/token/a%2Fb%20c");
  });

  it("有内部 id 但无图 → undefined(不代理空图)", () => {
    expect(tokenLogoUrl({ id: "uuid-3", hasLogo: false })).toBeUndefined();
  });

  it("有图但无内部 id → undefined(URL 不再进 payload,无 id 无从派生)", () => {
    expect(tokenLogoUrl({ hasLogo: true })).toBeUndefined();
  });

  it("完全无图 → undefined(客户端首字母,不发请求)", () => {
    expect(tokenLogoUrl({})).toBeUndefined();
  });
});

describe("toLogoSource(上游 URL → 有没有图)", () => {
  it("有 canonical / provider http 图 → hasLogo true", () => {
    expect(toLogoSource({ id: "x", logo: "https://cgk/usdc.png" })).toEqual({
      id: "x",
      hasLogo: true,
    });
    expect(toLogoSource({ id: "x", providerLogo: "https://zerion/x.png" })).toEqual({
      id: "x",
      hasLogo: true,
    });
  });

  it("data: 内嵌图也算「有图」→ hasLogo true(由 id 经代理拿,不再进 payload)", () => {
    expect(toLogoSource({ id: "x", providerLogo: "data:image/png;base64,AA" })).toEqual({
      id: "x",
      hasLogo: true,
    });
    expect(toLogoSource({ id: "x", logo: "data:image/svg+xml;base64,AA" })).toEqual({
      id: "x",
      hasLogo: true,
    });
  });

  it("一张图都没有 → hasLogo false", () => {
    expect(toLogoSource({ id: "x" })).toEqual({ id: "x", hasLogo: false });
  });
});

describe("platformLogoUrl", () => {
  it("有上游图 → 代理 URL(平台 key 即稳定 id)", () => {
    expect(platformLogoUrl("bitcoin", "https://cgk/btc.png")).toBe("/api/logo/platform/bitcoin");
  });

  it("key 含特殊字符(:)被编码", () => {
    expect(platformLogoUrl("evm:1", "https://cgk/eth.png")).toBe("/api/logo/platform/evm%3A1");
  });

  it("无上游图 → undefined(客户端 fallback,不发请求)", () => {
    expect(platformLogoUrl("bitcoin")).toBeUndefined();
    expect(platformLogoUrl("exchange:binance", undefined)).toBeUndefined();
  });
});

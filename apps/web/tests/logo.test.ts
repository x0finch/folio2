import { describe, expect, it } from "vitest";
import { platformLogoUrl, tokenLogoUrl, toLogoSource } from "@/lib/core/logo";

describe("tokenLogoUrl", () => {
  it("internal id + image: proxy URL (client never references a third-party CDN; URL derives from the id, not in the payload)", () => {
    expect(tokenLogoUrl({ id: "uuid-1", hasLogo: true })).toBe("/api/logo/token/uuid-1");
  });

  it("special characters in the internal id are encoded", () => {
    expect(tokenLogoUrl({ id: "a/b c", hasLogo: true })).toBe("/api/logo/token/a%2Fb%20c");
  });

  it("internal id but no image: undefined (empty images are not proxied)", () => {
    expect(tokenLogoUrl({ id: "uuid-3", hasLogo: false })).toBeUndefined();
  });

  it("image but no internal id: undefined (URL is not in the payload, nothing to derive it from without an id)", () => {
    expect(tokenLogoUrl({ hasLogo: true })).toBeUndefined();
  });

  it("no image at all: undefined (client shows the initial, sends no request)", () => {
    expect(tokenLogoUrl({})).toBeUndefined();
  });
});

describe("toLogoSource (upstream URL: has image or not)", () => {
  it("canonical / provider http image: hasLogo true", () => {
    expect(toLogoSource({ id: "x", logo: "https://cgk/usdc.png" })).toEqual({
      id: "x",
      hasLogo: true,
    });
    expect(toLogoSource({ id: "x", providerLogo: "https://zerion/x.png" })).toEqual({
      id: "x",
      hasLogo: true,
    });
  });

  it("inline data: image also counts as having an image: hasLogo true (fetched via the proxy by id, not in the payload)", () => {
    expect(toLogoSource({ id: "x", providerLogo: "data:image/png;base64,AA" })).toEqual({
      id: "x",
      hasLogo: true,
    });
    expect(toLogoSource({ id: "x", logo: "data:image/svg+xml;base64,AA" })).toEqual({
      id: "x",
      hasLogo: true,
    });
  });

  it("no image at all: hasLogo false", () => {
    expect(toLogoSource({ id: "x" })).toEqual({ id: "x", hasLogo: false });
  });
});

describe("platformLogoUrl", () => {
  it("upstream image: proxy URL (platform key is the stable id)", () => {
    expect(platformLogoUrl("bitcoin", "https://cgk/btc.png")).toBe("/api/logo/platform/bitcoin");
  });

  it("key with special characters (:) is encoded", () => {
    expect(platformLogoUrl("evm:1", "https://cgk/eth.png")).toBe("/api/logo/platform/evm%3A1");
  });

  it("no upstream image: undefined (client fallback, no request)", () => {
    expect(platformLogoUrl("bitcoin")).toBeUndefined();
    expect(platformLogoUrl("exchange:binance", undefined)).toBeUndefined();
  });
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { isCacheableAsset, swRoute } from "../public/sw.js";

it("public/sw.js carries the __SW_BUILD__ version placeholder (stamped at build time to trigger update detection)", () => {
  const src = readFileSync(new URL("../public/sw.js", import.meta.url), "utf-8");
  expect(src).toContain("__SW_BUILD__");
});

const base = {
  method: "GET",
  mode: "cors",
  destination: "",
  sameOrigin: true,
  pathname: "/x",
};

describe("swRoute", () => {
  it("navigation (document): network-first", () => {
    expect(swRoute({ ...base, mode: "navigate" })).toBe("navigation");
  });

  it("/api/*: network-only (data / auth, never cached)", () => {
    expect(swRoute({ ...base, pathname: "/api/auth/get-session" })).toBe("network-only");
    expect(swRoute({ ...base, pathname: "/api/accounts" })).toBe("network-only");
  });

  it("script / style / font under /assets/ (content-hashed): cache-first", () => {
    expect(swRoute({ ...base, destination: "script", pathname: "/assets/app-abc12345.js" })).toBe(
      "cache-first",
    );
    expect(
      swRoute({ ...base, destination: "style", pathname: "/assets/styles-abc12345.css" }),
    ).toBe("cache-first");
    expect(
      swRoute({ ...base, destination: "font", pathname: "/assets/geist-abc12345.woff2" }),
    ).toBe("cache-first");
  });

  it("script / style / font outside /assets/: network-only (URL not hashed, content changes)", () => {
    expect(swRoute({ ...base, destination: "style", pathname: "/src/styles.css" })).toBe(
      "network-only",
    );
    expect(swRoute({ ...base, destination: "script", pathname: "/src/client.tsx" })).toBe(
      "network-only",
    );
    expect(swRoute({ ...base, destination: "font", pathname: "/fonts/geist.woff2" })).toBe(
      "network-only",
    );
  });

  it("non-GET (server fn / mutation): network-only", () => {
    expect(swRoute({ ...base, method: "POST", destination: "script" })).toBe("network-only");
  });

  it("cross-origin: network-only (e.g. logo proxy targets)", () => {
    expect(swRoute({ ...base, destination: "image", sameOrigin: false })).toBe("network-only");
  });

  it("same-origin images / other: network-only (stay fresh, no offline-first)", () => {
    expect(swRoute({ ...base, destination: "image", pathname: "/pwa-192.png" })).toBe(
      "network-only",
    );
    expect(swRoute({ ...base, pathname: "/manifest.json" })).toBe("network-only");
  });

  it("navigation takes precedence over path checks", () => {
    expect(swRoute({ ...base, mode: "navigate", pathname: "/api/x" })).toBe("navigation");
  });
});

describe("isCacheableAsset", () => {
  it("script accepts JavaScript only", () => {
    expect(isCacheableAsset("script", "text/javascript; charset=utf-8")).toBe(true);
    expect(isCacheableAsset("script", "application/javascript")).toBe(true);
    expect(isCacheableAsset("script", "text/html; charset=utf-8")).toBe(false);
  });
  it("style accepts CSS only", () => {
    expect(isCacheableAsset("style", "text/css")).toBe(true);
    expect(isCacheableAsset("style", "text/html")).toBe(false);
  });
  it("font accepts font/* and octet-stream", () => {
    expect(isCacheableAsset("font", "font/woff2")).toBe(true);
    expect(isCacheableAsset("font", "application/octet-stream")).toBe(true);
    expect(isCacheableAsset("font", "text/html")).toBe(false);
  });
  it("no content type or another destination: not cached", () => {
    expect(isCacheableAsset("script", null)).toBe(false);
    expect(isCacheableAsset("image", "image/png")).toBe(false);
  });
});

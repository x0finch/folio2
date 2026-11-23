import { describe, expect, it } from "vitest";
import { isNewerVersion, parseSwBuild } from "@/lib/pwa/version";

// Update detection compares the live sw.js `@sw-build` stamp with this load's __APP_VERSION__.

describe("parseSwBuild", () => {
  it("extracts the build version stamped into sw.js", () => {
    expect(parseSwBuild("// @sw-build v0.14.0-27-g6db1271\nconst CACHE=1;")).toBe(
      "v0.14.0-27-g6db1271",
    );
  });

  it("unbuilt (placeholder text) -> returns the placeholder (isNewerVersion treats it as none)", () => {
    expect(parseSwBuild("// @sw-build __SW_BUILD__")).toBe("__SW_BUILD__");
  });

  it("no @sw-build line -> null", () => {
    expect(parseSwBuild("const CACHE='folio-shell-v2';")).toBeNull();
  });
});

describe("isNewerVersion", () => {
  it("live differs from running -> newer version", () => {
    expect(isNewerVersion("v0.14.0-27", "v0.14.0-25")).toBe(true);
  });

  it("same version -> no newer version (cold start: network-first is already current)", () => {
    expect(isNewerVersion("v0.14.0-27", "v0.14.0-27")).toBe(false);
  });

  it("unparsable / placeholder / dev -> no newer version (no false alarm)", () => {
    expect(isNewerVersion(null, "v0.14.0-25")).toBe(false);
    expect(isNewerVersion("__SW_BUILD__", "v0.14.0-25")).toBe(false);
    expect(isNewerVersion("v0.14.0-27", "dev")).toBe(false);
    expect(isNewerVersion("v0.14.0-27", "")).toBe(false);
  });
});

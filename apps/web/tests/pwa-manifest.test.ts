import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  appCssLoaderScript,
  PWA_LINKS,
  PWA_META,
  SPLASH_STYLE,
  THEME_COLORS,
  VIEWPORT,
} from "@/routes/-root/pwa-head";
import { SPLASH_LOGO_SIZE } from "@/routes/-root/splash-lifecycle";

// Only the manifest shape and head tags are cheap to automate; installability, safe areas and the
// update flow are checked with Lighthouse and real devices.

const manifest = JSON.parse(
  readFileSync(new URL("../public/manifest.json", import.meta.url), "utf-8"),
) as Record<string, unknown>;

describe("PWA manifest", () => {
  it("is the real Folio manifest (not the TanStack boilerplate)", () => {
    expect(manifest.name).toBe("Folio");
    expect(manifest.short_name).toBe("Folio");
    expect(String(manifest.name)).not.toContain("TanStack");
  });

  it("has the required installability fields", () => {
    expect(manifest.start_url).toBe("/");
    expect(manifest.scope).toBe("/");
    expect(manifest.display).toBe("standalone");
    expect(typeof manifest.theme_color).toBe("string");
    expect(typeof manifest.background_color).toBe("string");
  });

  it("icons include 192, 512 (any) and one maskable", () => {
    const icons = manifest.icons as { sizes: string; purpose?: string }[];
    expect(icons.some((i) => i.sizes === "192x192")).toBe(true);
    expect(icons.some((i) => i.sizes === "512x512")).toBe(true);
    expect(icons.some((i) => i.purpose === "maskable")).toBe(true);
  });
});

describe("PWA head elements", () => {
  it("links include the manifest and apple-touch-icon", () => {
    expect(PWA_LINKS.some((l) => l.rel === "manifest" && l.href === "/manifest.json")).toBe(true);
    expect(PWA_LINKS.some((l) => l.rel === "apple-touch-icon")).toBe(true);
  });

  it("theme-color for light and dark (each with a prefers-color-scheme media; rendered statically to dodge TanStack's dedupe by name)", () => {
    expect(THEME_COLORS).toHaveLength(2);
    expect(THEME_COLORS.some((m) => m.media.includes("light"))).toBe(true);
    expect(THEME_COLORS.some((m) => m.media.includes("dark"))).toBe(true);
  });

  it("has apple-mobile-web-app tags (standalone window + title)", () => {
    expect(PWA_META.some((m) => m.name === "apple-mobile-web-app-capable")).toBe(true);
    expect(
      PWA_META.some((m) => m.name === "apple-mobile-web-app-title" && m.content === "Folio"),
    ).toBe(true);
  });

  it("viewport includes viewport-fit=cover (safe-area basis)", () => {
    expect(VIEWPORT).toContain("viewport-fit=cover");
    expect(VIEWPORT).toContain("width=device-width");
  });
});

// No blank first paint: splash critical CSS is inlined in head; the app stylesheet is non-blocking.
describe("Cold-start splash head mechanism", () => {
  it("SPLASH_STYLE is self-contained critical CSS: overlay + breathing + logo size + exit + fallback", () => {
    expect(SPLASH_STYLE).toContain("#app-splash");
    expect(SPLASH_STYLE).toContain("@keyframes folio-breathe");
    // Logo size comes from the shared constant, not hardcoded.
    expect(SPLASH_STYLE).toContain(`${SPLASH_LOGO_SIZE}px`);
    // Exit release and the reduced-motion fallback are both present.
    expect(SPLASH_STYLE).toContain('[data-exit="true"]');
    expect(SPLASH_STYLE).toContain("prefers-reduced-motion");
  });

  it("app stylesheet is injected by script (not render-blocking), not a blocking <link> in head", () => {
    const script = appCssLoaderScript("/assets/app-abc12345.css");
    // A script-injected link does not block first paint; it must be a stylesheet link with an href.
    expect(script).toContain("createElement('link')");
    expect(script).toContain("stylesheet");
    expect(script).toContain("/assets/app-abc12345.css");
  });

  it("PWA_LINKS no longer carries the app stylesheet as a blocking stylesheet", () => {
    expect(PWA_LINKS.every((l) => l.rel !== "stylesheet")).toBe(true);
  });
});

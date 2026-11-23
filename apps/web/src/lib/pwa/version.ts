// The build stamps the real version over this placeholder in public/sw.js; unbuilt means "none".
const SW_BUILD_PLACEHOLDER = "__SW_BUILD__";

export function parseSwBuild(swSource: string): string | null {
  return swSource.match(/@sw-build\s+(\S+)/)?.[1] ?? null;
}

/**
 * Compares version strings rather than SW waiting state: with network-first navigation a cold
 * start is always current, so only a long-open session can fall behind.
 */
export function isNewerVersion(deployed: string | null, running: string): boolean {
  if (!deployed || deployed === SW_BUILD_PLACEHOLDER) return false;
  if (!running || running === "dev") return false;
  return deployed !== running;
}

// typeof guard: vitest doesn't apply vite `define`, so a bare reference would throw.
export const RUNNING_VERSION = typeof __APP_VERSION__ === "undefined" ? "dev" : __APP_VERSION__;

/** Drops git describe's `-g<hash>` suffix for display. */
export function stripBuildHash(version: string): string {
  return version.replace(/-g[0-9a-f]+$/i, "");
}

import { defineConfig } from "vitest/config";

// Root test runner for the library packages. Each `@folio/*` package is
// auto-discovered via these globs as it's added in later phases.
// `apps/web` runs its own Vitest (it needs the Cloudflare/Vite app config),
// invoked through `pnpm -r test`.
export default defineConfig({
  test: {
    // Match each package's own vitest.config.ts (any depth) — NOT the dirs, so
    // container-only folders (packages/providers, packages/tokens, …) aren't
    // picked up as unnamed, colliding projects.
    projects: ["packages/**/vitest.config.ts"],
    passWithNoTests: true,
  },
});

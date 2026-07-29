import { defineConfig } from "vitest/config";

// Root test runner for the library packages. Each `@folio/*` package is
// auto-discovered via these globs as it's added in later phases.
// `apps/web` runs its own Vitest (it needs the Cloudflare/Vite app config),
// invoked through `pnpm -r test`.
export default defineConfig({
  test: {
    // Match each package's own config file (any depth) — NOT the dirs, so
    // container-only folders (packages/providers, packages/tokens, …) aren't
    // picked up as unnamed, colliding projects.
    //
    // The second pattern matters: CI runs *this* runner (`pnpm test:packages`), so a package's
    // workers-pool config has to be listed here or its tests silently never run in CI. That is
    // the whole point of @folio/connectors-provider-rabby's — the wasm signing guard is
    // meaningless anywhere but workerd, since node happily compiles wasm at runtime and would
    // give a false green. Each such config must set a `name` distinct from its sibling's.
    projects: ["packages/**/vitest.config.ts", "packages/**/vitest.workers.config.ts"],
    passWithNoTests: true,
  },
});

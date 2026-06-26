import { defineConfig } from "vitest/config";

// Per-package config so `vitest run` here uses its own settings instead of
// inheriting the root `projects` config. Pure node env: the orchestrator takes
// db ops as injected deps (no D1), so no cloudflare test pool is needed here.
export default defineConfig({
  test: {
    environment: "node",
  },
});

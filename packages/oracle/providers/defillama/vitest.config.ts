import { defineConfig } from "vitest/config";

// Per-package config so `vitest run` here uses its own settings instead of
// inheriting the root `projects` config. The root runner (`pnpm test:packages`)
// discovers this package because it has this config file.
export default defineConfig({
  test: {
    environment: "node",
  },
});

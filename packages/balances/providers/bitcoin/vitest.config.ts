import { defineConfig } from "vitest/config";

// Per-package config so `vitest run` here uses its own settings instead of
// inheriting the root `projects` config.
export default defineConfig({
  test: {
    environment: "node",
  },
});

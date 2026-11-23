import { defineConfig } from "vitest/config";

// Standalone config: this package's `vitest run` does not inherit the root `projects`; the root runner discovers it through this file.
export default defineConfig({
  test: {
    environment: "node",
  },
});

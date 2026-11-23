import { defineConfig } from "vitest/config";

// Vendored components are not unit-tested; an empty config lets the root runner skip this package.
export default defineConfig({
  test: {
    passWithNoTests: true,
  },
});

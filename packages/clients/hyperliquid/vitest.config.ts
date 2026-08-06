import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "hyperliquid-client", include: ["tests/**/*.test.ts"] },
});

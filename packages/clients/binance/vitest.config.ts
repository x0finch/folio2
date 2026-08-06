import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "binance-client", include: ["tests/**/*.test.ts"] },
});

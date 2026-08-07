import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "bybit-client", include: ["tests/**/*.test.ts"] },
});

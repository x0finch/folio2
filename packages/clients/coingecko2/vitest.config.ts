import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "coingecko-client2", include: ["tests/**/*.test.ts"] },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "coinstats-client", include: ["tests/**/*.test.ts"] },
});

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "client-core", include: ["tests/**/*.test.ts"] },
});

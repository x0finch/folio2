import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "okx-client", include: ["tests/**/*.test.ts"] },
});

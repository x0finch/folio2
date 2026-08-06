import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "rabby-client", include: ["tests/**/*.test.ts"] },
});

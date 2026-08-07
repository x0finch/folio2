import { defineConfig } from "vitest/config";

export default defineConfig({
  test: { name: "blockbook-client", include: ["tests/**/*.test.ts"] },
});
